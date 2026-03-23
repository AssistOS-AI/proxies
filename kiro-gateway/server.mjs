#!/usr/bin/env node
/**
 * Kiro Gateway — OpenAI-compatible proxy for Kiro API.
 * Pure Node.js stdlib, no npm dependencies.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { URL, URLSearchParams } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8000', 10);
const PROXY_API_KEY = process.env.PROXY_API_KEY || 'kiro-gateway-key';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

const COGNITO_DOMAIN = 'kiro-prod-us-east-1.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = '59bd15eh40ee7pc20h0bkcu7id';
const SCOPES = 'email openid';

const REFRESH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const KIRO_API_HOST = 'q.us-east-1.amazonaws.com';
const CREDENTIALS_PATH = '/shared/kiro-gateway/credentials.json';

// OAuth callback port — must be registered in Cognito's allowed redirect URIs
// kiro-cli uses port 3128, which is registered
const OAUTH_CALLBACK_PORT = 3128;
const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth/callback`;
const KIRO_AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev';

const FINGERPRINT = crypto.randomBytes(8).toString('hex');
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[kiro-gw] ${msg}`);
}

// ---------------------------------------------------------------------------
// Dashboard session management (cookie-based)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'kiro_session';
const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours
const activeSessions = new Set();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function isDashboardAuthenticated(req) {
  if (!DASHBOARD_PASSWORD) return true; // no password set = open access
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  return token && activeSessions.has(token);
}

function getLoginPageHtml(error) {
  const errorHtml = error ? `<p class="error">${error}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kiro Gateway - Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #eee;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .container {
    background: rgba(255,255,255,0.05);
    border-radius: 20px;
    padding: 40px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    text-align: center;
  }
  h1 {
    font-size: 1.8rem;
    margin-bottom: 8px;
    background: linear-gradient(90deg, #00d4ff, #7b2ff7);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle { color: #888; margin-bottom: 30px; }
  form { display: flex; flex-direction: column; gap: 16px; }
  input[type="password"] {
    padding: 12px 16px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(0,0,0,0.3);
    color: #eee;
    font-size: 1rem;
    text-align: center;
  }
  input[type="password"]:focus { outline: none; border-color: #7b2ff7; }
  button {
    padding: 12px 24px;
    border-radius: 8px;
    border: none;
    background: linear-gradient(90deg, #7b2ff7, #00d4ff);
    color: white;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: transform 0.2s;
  }
  button:hover { transform: translateY(-2px); }
  .error { color: #e74c3c; font-size: 0.9rem; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <h1>Kiro Gateway</h1>
  <p class="subtitle">Enter password to continue</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Dashboard password" autofocus required />
    <button type="submit">Sign In</button>
  </form>
  ${errorHtml}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Credentials storage
// ---------------------------------------------------------------------------

/** @type {{ accessToken?: string, refreshToken?: string, expiresAt?: number, email?: string, profileArn?: string } | null} */
let credentials = null;

async function loadCredentials() {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    credentials = JSON.parse(raw);
    log(`Loaded credentials for ${credentials?.email || 'unknown'}`);
  } catch {
    credentials = null;
  }
}

async function saveCredentials() {
  try {
    await mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true });
    await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    log(`Saved credentials for ${credentials?.email || 'unknown'}`);
  } catch (e) {
    log(`Failed to save credentials: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} state -> verifier */
const pkceStore = new Map();

function generatePKCE() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTPS request. Returns { statusCode, headers, body }.
 */
function httpsRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Make a streaming HTTPS request. Returns { statusCode, headers, stream }.
 */
function httpsRequestStream(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOpts, (res) => {
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        stream: res,
      });
    });

    req.on('error', reject);
    req.setTimeout(300_000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// JWT decode (no verification — just base64 payload)
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

let refreshInProgress = null;

async function refreshTokens() {
  if (!credentials?.refreshToken) {
    throw new Error('No refresh token available');
  }

  log('Refreshing tokens...');
  const res = await httpsRequest(REFRESH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `KiroIDE-0.7.45-${crypto.randomBytes(8).toString('hex')}`,
    },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
  });

  if (res.statusCode !== 200) {
    const body = res.body.toString();
    log(`Token refresh failed: ${res.statusCode} ${body}`);
    throw new Error(`Token refresh failed: ${res.statusCode}`);
  }

  const data = JSON.parse(res.body.toString());
  credentials.accessToken = data.accessToken;
  if (data.refreshToken) {
    credentials.refreshToken = data.refreshToken;
  }
  if (data.profileArn) {
    credentials.profileArn = data.profileArn;
  }
  credentials.expiresAt = Date.now() + (data.expiresIn || 3600) * 1000;

  await saveCredentials();
  log('Tokens refreshed successfully');
}

/**
 * Ensure access token is valid. Refreshes if expiring within 10 minutes.
 */
async function ensureValidToken() {
  if (!credentials?.accessToken) {
    throw new Error('Not authenticated');
  }

  const expiresAt = credentials.expiresAt || 0;
  if (Date.now() + TOKEN_REFRESH_MARGIN_MS < expiresAt) {
    return; // still valid
  }

  // Coalesce concurrent refresh requests
  if (!refreshInProgress) {
    refreshInProgress = refreshTokens().finally(() => {
      refreshInProgress = null;
    });
  }
  await refreshInProgress;
}

// ---------------------------------------------------------------------------
// Kiro API headers
// ---------------------------------------------------------------------------

function kiroHeaders() {
  return {
    'Authorization': `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${FINGERPRINT}`,
    'x-amzn-codewhisperer-optout': 'true',
    'x-amzn-kiro-agent-mode': 'vibe',
    'amz-sdk-invocation-id': crypto.randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  };
}

// ---------------------------------------------------------------------------
// Model cache
// ---------------------------------------------------------------------------

let cachedModels = null;
let modelsLastFetched = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function fetchKiroModels() {
  if (cachedModels && Date.now() - modelsLastFetched < MODELS_CACHE_TTL) {
    return cachedModels;
  }

  await ensureValidToken();
  const res = await httpsRequest(
    `https://${KIRO_API_HOST}/ListAvailableModels?origin=AI_EDITOR`,
    { headers: kiroHeaders() }
  );

  if (res.statusCode === 401 || res.statusCode === 403) {
    // retry once after refresh
    await refreshTokens();
    const res2 = await httpsRequest(
      `https://${KIRO_API_HOST}/ListAvailableModels?origin=AI_EDITOR`,
      { headers: kiroHeaders() }
    );
    if (res2.statusCode !== 200) {
      throw new Error(`ListAvailableModels failed: ${res2.statusCode}`);
    }
    const data = JSON.parse(res2.body.toString());
    cachedModels = data.models || [];
    modelsLastFetched = Date.now();
    return cachedModels;
  }

  if (res.statusCode !== 200) {
    throw new Error(`ListAvailableModels failed: ${res.statusCode} ${res.body.toString()}`);
  }

  const data = JSON.parse(res.body.toString());
  cachedModels = data.models || [];
  modelsLastFetched = Date.now();
  return cachedModels;
}

// ---------------------------------------------------------------------------
// Model name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize model name: convert trailing version dashes to dots.
 * claude-sonnet-4-5 -> claude-sonnet-4.5
 * claude-opus-4-6 -> claude-opus-4.6
 * claude-3-7-sonnet -> claude-3.7-sonnet
 */
function normalizeModelName(name) {
  // Match patterns like X-Y where Y is a single digit at the end or before -sonnet etc.
  // Strategy: find sequences that look like version numbers (digit-digit) and convert dash to dot.
  // We handle: "claude-sonnet-4-5" -> "claude-sonnet-4.5"
  //            "claude-opus-4-6"   -> "claude-opus-4.6"
  //            "claude-3-7-sonnet" -> "claude-3.7-sonnet"
  return name.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2');
}

// ---------------------------------------------------------------------------
// AWS Event Stream binary parser
// ---------------------------------------------------------------------------

/**
 * Parse AWS event stream header bytes into an array of {name, type, value}.
 */
function parseEventStreamHeaders(buf) {
  const headers = [];
  let offset = 0;
  while (offset < buf.length) {
    const nameLen = buf.readUInt8(offset);
    offset += 1;
    const name = buf.subarray(offset, offset + nameLen).toString('utf-8');
    offset += nameLen;
    const headerType = buf.readUInt8(offset);
    offset += 1;

    let value;
    switch (headerType) {
      case 0: // bool true
        value = true;
        break;
      case 1: // bool false
        value = false;
        break;
      case 2: // byte
        value = buf.readUInt8(offset);
        offset += 1;
        break;
      case 3: // short
        value = buf.readInt16BE(offset);
        offset += 2;
        break;
      case 4: // int
        value = buf.readInt32BE(offset);
        offset += 4;
        break;
      case 5: // long (8 bytes)
        value = buf.readBigInt64BE(offset);
        offset += 8;
        break;
      case 6: // bytes
      {
        const bytesLen = buf.readUInt16BE(offset);
        offset += 2;
        value = buf.subarray(offset, offset + bytesLen);
        offset += bytesLen;
        break;
      }
      case 7: // string
      {
        const strLen = buf.readUInt16BE(offset);
        offset += 2;
        value = buf.subarray(offset, offset + strLen).toString('utf-8');
        offset += strLen;
        break;
      }
      case 8: // timestamp
        value = Number(buf.readBigInt64BE(offset));
        offset += 8;
        break;
      case 9: // uuid
        value = buf.subarray(offset, offset + 16).toString('hex');
        offset += 16;
        break;
      default:
        // Unknown type — bail
        return headers;
    }
    headers.push({ name, type: headerType, value });
  }
  return headers;
}

/**
 * Parse a single event-stream message from a buffer.
 * Returns { totalLength, headers, payload } or null if buffer is too short.
 */
function parseEventStreamMessage(buf, offset = 0) {
  if (buf.length - offset < 12) return null; // prelude is 12 bytes

  const totalLength = buf.readUInt32BE(offset);
  const headersLength = buf.readUInt32BE(offset + 4);
  // bytes 8-11: prelude CRC (skip)

  if (buf.length - offset < totalLength) return null; // not enough data yet

  const headersStart = offset + 12;
  const headersBuf = buf.subarray(headersStart, headersStart + headersLength);
  const headers = parseEventStreamHeaders(headersBuf);

  const payloadLength = totalLength - headersLength - 16; // 12 prelude + 4 message CRC
  const payloadStart = headersStart + headersLength;
  const payload = buf.subarray(payloadStart, payloadStart + payloadLength);

  return { totalLength, headers, payload };
}

/**
 * Extract all event-stream messages from a buffer.
 */
function parseAllEvents(buf) {
  const events = [];
  let offset = 0;
  while (offset < buf.length) {
    const msg = parseEventStreamMessage(buf, offset);
    if (!msg) break;
    events.push(msg);
    offset += msg.totalLength;
  }
  return events;
}

// ---------------------------------------------------------------------------
// OpenAI <-> Kiro format conversions
// ---------------------------------------------------------------------------

function convertToolsToKiro(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t.type === 'function' && t.function)
    .map((t) => ({
      toolSpecification: {
        name: t.function.name,
        description: t.function.description || '',
        inputSchema: { json: t.function.parameters || {} },
      },
    }));
}

/**
 * Build the Kiro conversationState from an OpenAI chat request body.
 */
function buildKiroRequest(body) {
  const model = normalizeModelName(body.model || 'claude-sonnet-4.5');
  const messages = body.messages || [];
  const tools = convertToolsToKiro(body.tools);

  // Separate system messages, build history, and identify currentMessage
  let systemPrefix = '';
  const historyItems = [];
  let lastUserContent = '';
  let lastUserToolResults = [];

  // Collect system messages first
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrefix += (systemPrefix ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Group tool results that follow assistant tool_calls
  // Process messages to build history pairs
  const processed = [];
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i];
    if (msg.role === 'tool') {
      // Attach to previous entry's toolResults
      if (processed.length > 0) {
        const prev = processed[processed.length - 1];
        if (!prev._toolResults) prev._toolResults = [];
        prev._toolResults.push({
          toolUseId: msg.tool_call_id || '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          status: 'SUCCESS',
        });
      }
      continue;
    }
    processed.push({ ...msg });
  }

  // All processed messages except the last user become history
  // The last user message becomes currentMessage
  let currentUserIdx = -1;
  for (let i = processed.length - 1; i >= 0; i--) {
    if (processed[i].role === 'user') {
      currentUserIdx = i;
      break;
    }
  }

  // Build history from everything before currentUserIdx
  for (let i = 0; i < processed.length; i++) {
    if (i === currentUserIdx) continue;
    const msg = processed[i];

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const userMsg = {
        userInputMessage: {
          content: (i === 0 && systemPrefix) ? systemPrefix + '\n\n' + content : content,
          modelId: model,
          origin: 'AI_EDITOR',
        },
      };
      if (msg._toolResults && msg._toolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: msg._toolResults,
        };
      }
      historyItems.push(userMsg);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        historyItems.push({
          assistantResponseMessage: {
            content: msg.content || '',
            toolUses: msg.tool_calls.map((tc) => ({
              name: tc.function?.name || '',
              input: safeParseJSON(tc.function?.arguments),
              toolUseId: tc.id || '',
            })),
          },
        });
      } else {
        historyItems.push({
          assistantResponseMessage: {
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
          },
        });
      }
    }
  }

  // Build currentMessage
  if (currentUserIdx >= 0) {
    const msg = processed[currentUserIdx];
    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    lastUserContent = (currentUserIdx === 0 && systemPrefix) ? systemPrefix + '\n\n' + rawContent : rawContent;
    if (msg._toolResults) {
      lastUserToolResults = msg._toolResults;
    }
  } else {
    // No user message at all — use empty
    lastUserContent = systemPrefix || '';
  }

  // Also prepend system to first user in history if currentUserIdx != 0
  // (already handled above for i===0 case)

  const currentMessage = {
    userInputMessage: {
      content: lastUserContent,
      modelId: model,
      origin: 'AI_EDITOR',
      userInputMessageContext: {},
    },
  };

  if (tools && tools.length > 0) {
    currentMessage.userInputMessage.userInputMessageContext.tools = tools;
  }
  if (lastUserToolResults.length > 0) {
    currentMessage.userInputMessage.userInputMessageContext.toolResults = lastUserToolResults;
  }

  // Clean up empty context
  if (Object.keys(currentMessage.userInputMessage.userInputMessageContext).length === 0) {
    delete currentMessage.userInputMessage.userInputMessageContext;
  }

  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: crypto.randomUUID(),
      currentMessage,
      history: historyItems,
    },
  };
}

function safeParseJSON(str) {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

// ---------------------------------------------------------------------------
// /v1/chat/completions — streaming proxy
// ---------------------------------------------------------------------------

async function handleChatCompletions(req, res, body) {
  const requestBody = JSON.parse(body);
  const wantStream = requestBody.stream !== false;
  const model = requestBody.model || 'claude-sonnet-4.5';
  const kiroPayload = buildKiroRequest(requestBody);

  await ensureValidToken();

  const kiroRes = await httpsRequestStream(
    `https://${KIRO_API_HOST}/generateAssistantResponse`,
    {
      method: 'POST',
      headers: kiroHeaders(),
      body: JSON.stringify(kiroPayload),
    }
  );

  // Handle auth errors with one retry
  if (kiroRes.statusCode === 401 || kiroRes.statusCode === 403) {
    // Consume the error body
    await new Promise((resolve) => {
      kiroRes.stream.on('data', () => {});
      kiroRes.stream.on('end', resolve);
    });
    await refreshTokens();

    return handleChatCompletionsRetry(requestBody, wantStream, model, res);
  }

  if (kiroRes.statusCode === 429) {
    const errBody = await consumeStream(kiroRes.stream);
    sendJSON(res, 429, {
      error: { message: 'Rate limited by Kiro API', type: 'rate_limit_error' },
    });
    return;
  }

  if (kiroRes.statusCode !== 200) {
    const errBody = await consumeStream(kiroRes.stream);
    log(`Kiro API error: ${kiroRes.statusCode} ${errBody.toString()}`);
    sendJSON(res, 502, {
      error: {
        message: `Kiro API returned ${kiroRes.statusCode}`,
        type: 'upstream_error',
      },
    });
    return;
  }

  // Collect the full binary event stream then parse
  const chatId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send role chunk first
    const roleChunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // Parse event stream as it arrives
    let buffer = Buffer.alloc(0);
    let fullContent = '';
    let toolUses = [];

    kiroRes.stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      log(`Stream chunk: ${chunk.length} bytes, buffer: ${buffer.length} bytes, hex: ${chunk.slice(0, 40).toString('hex')}... text: ${chunk.slice(0, 100).toString('utf-8').replace(/\n/g, '\\n')}`);

      // Try to parse complete messages from buffer
      let offset = 0;
      while (offset < buffer.length) {
        const msg = parseEventStreamMessage(buffer, offset);
        if (!msg) break;
        offset += msg.totalLength;

        // Extract event type from headers
        let eventType = '';
        for (const h of msg.headers) {
          if (h.name === ':event-type') {
            eventType = h.value;
          }
        }

        if (msg.payload.length > 0) {
          try {
            const payload = JSON.parse(msg.payload.toString('utf-8'));
            log(`Event: type=${eventType} keys=${Object.keys(payload).join(',')} payload=${JSON.stringify(payload).substring(0, 200)}`);

            // Handle AssistantResponseEvent
            if (eventType === 'assistantResponseEvent' || eventType === 'AssistantResponseEvent' || payload.assistantResponseEvent) {
              const evt = payload.assistantResponseEvent || payload;
              if (evt.content) {
                fullContent += evt.content;
                const sseChunk = {
                  id: chatId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: evt.content },
                    finish_reason: null,
                  }],
                };
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
              }

              // Handle tool use events
              if (evt.toolUse) {
                toolUses.push(evt.toolUse);
              }
            }

            // Handle CodeEvent or other content-carrying events
            if (payload.codeEvent?.content) {
              fullContent += payload.codeEvent.content;
              const sseChunk = {
                id: chatId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: payload.codeEvent.content },
                  finish_reason: null,
                }],
              };
              res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
            }
          } catch {
            // Not JSON — skip
          }
        }
      }
      // Keep unparsed remainder in buffer
      buffer = buffer.subarray(offset);
    });

    kiroRes.stream.on('end', () => {
      // Send tool_calls if any
      if (toolUses.length > 0) {
        const toolCallsChunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: toolUses.map((tu, i) => ({
                index: i,
                id: tu.toolUseId || `call_${crypto.randomBytes(8).toString('hex')}`,
                type: 'function',
                function: {
                  name: tu.name,
                  arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
                },
              })),
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(toolCallsChunk)}\n\n`);
      }

      // Send finish chunk
      const finishChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop',
        }],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    kiroRes.stream.on('error', (err) => {
      log(`Stream error: ${err.message}`);
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } else {
    // Non-streaming: collect full response
    const rawBody = await consumeStream(kiroRes.stream);
    const events = parseAllEvents(rawBody);

    let fullContent = '';
    let toolUses = [];

    for (const evt of events) {
      if (evt.payload.length === 0) continue;
      try {
        const payload = JSON.parse(evt.payload.toString('utf-8'));
        if (payload.assistantResponseEvent?.content) {
          fullContent += payload.assistantResponseEvent.content;
        }
        if (payload.codeEvent?.content) {
          fullContent += payload.codeEvent.content;
        }
        if (payload.assistantResponseEvent?.toolUse) {
          toolUses.push(payload.assistantResponseEvent.toolUse);
        }
      } catch {
        // skip non-JSON
      }
    }

    const message = { role: 'assistant', content: fullContent };
    if (toolUses.length > 0) {
      message.tool_calls = toolUses.map((tu, i) => ({
        id: tu.toolUseId || `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
        },
      }));
    }

    sendJSON(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

async function handleChatCompletionsRetry(requestBody, wantStream, model, res) {
  const kiroPayload = buildKiroRequest(requestBody);
  const kiroRes = await httpsRequestStream(
    `https://${KIRO_API_HOST}/generateAssistantResponse`,
    {
      method: 'POST',
      headers: kiroHeaders(),
      body: JSON.stringify(kiroPayload),
    }
  );

  if (kiroRes.statusCode !== 200) {
    const errBody = await consumeStream(kiroRes.stream);
    log(`Kiro API error on retry: ${kiroRes.statusCode} ${errBody.toString()}`);
    sendJSON(res, 502, {
      error: { message: `Kiro API returned ${kiroRes.statusCode} after refresh`, type: 'upstream_error' },
    });
    return;
  }

  // Re-use the same streaming/non-streaming logic
  // For simplicity, do non-streaming on retry
  const chatId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const rawBody = await consumeStream(kiroRes.stream);
  const events = parseAllEvents(rawBody);

  let fullContent = '';
  let toolUses = [];
  for (const evt of events) {
    if (evt.payload.length === 0) continue;
    try {
      const payload = JSON.parse(evt.payload.toString('utf-8'));
      if (payload.assistantResponseEvent?.content) {
        fullContent += payload.assistantResponseEvent.content;
      }
      if (payload.codeEvent?.content) {
        fullContent += payload.codeEvent.content;
      }
      if (payload.assistantResponseEvent?.toolUse) {
        toolUses.push(payload.assistantResponseEvent.toolUse);
      }
    } catch { /* skip */ }
  }

  const message = { role: 'assistant', content: fullContent };
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((tu) => ({
      id: tu.toolUseId || `call_${crypto.randomBytes(8).toString('hex')}`,
      type: 'function',
      function: {
        name: tu.name,
        arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
      },
    }));
  }

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: fullContent },
        finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop',
      }],
    };
    if (toolUses.length > 0) {
      chunk.choices[0].delta.tool_calls = toolUses.map((tu, i) => ({
        index: i,
        id: tu.toolUseId || `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
        },
      }));
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    sendJSON(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

function consumeStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    'Location': location,
    'Access-Control-Allow-Origin': '*',
  });
  res.end();
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// ---------------------------------------------------------------------------
// Read request body
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Auth check middleware
// ---------------------------------------------------------------------------

function checkApiKey(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7) === PROXY_API_KEY;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OAuth callback server on port 3128 (matches Cognito-registered redirect URI)
// ---------------------------------------------------------------------------

let callbackServer = null;

async function handleOAuthCallback(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    log(`OAuth error: ${error} - ${url.searchParams.get('error_description')}`);
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h2>OAuth Error: ${error}</h2><p><a href="http://localhost:${PORT}/">Back to dashboard</a></p></body></html>`);
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Missing code or state</h2></body></html>');
    return;
  }

  const verifier = pkceStore.get(state);
  if (!verifier) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Invalid or expired state. Try logging in again.</h2></body></html>');
    return;
  }
  pkceStore.delete(state);

  // Exchange code for tokens via Kiro Desktop Auth service
  // This service wraps Cognito and handles the client secret server-side
  // Uses form-urlencoded with camelCase parameter names
  const tokenParams = new URLSearchParams({
    grantType: 'authorization_code',
    clientId: CLIENT_ID,
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT_URI,
  });

  try {
    const tokenBody = JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    log(`Token exchange at ${new Date().toISOString()}`);
    const tokenRes = await httpsRequest(`${KIRO_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': `KiroIDE-0.7.45-${FINGERPRINT}`,
      },
      body: tokenBody,
    });

    if (tokenRes.statusCode !== 200) {
      log(`Token exchange failed: ${tokenRes.statusCode} ${tokenRes.body.toString()}`);
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>Token exchange failed (${tokenRes.statusCode})</h2><p><a href="http://localhost:${PORT}/">Back to dashboard</a></p></body></html>`);
      return;
    }

    // Kiro Desktop Auth returns camelCase: accessToken, refreshToken, expiresIn, profileArn
    const tokenData = JSON.parse(tokenRes.body.toString());

    credentials = {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: Date.now() + (tokenData.expiresIn || 3600) * 1000,
      email: tokenData.email || null,
      profileArn: tokenData.profileArn || null,
    };

    // If no email in response, try to decode from JWT if present
    if (!credentials.email && tokenData.idToken) {
      const idPayload = decodeJwtPayload(tokenData.idToken);
      credentials.email = idPayload?.email || null;
    }

    await saveCredentials();
    log(`Authenticated as ${credentials.email}`);

    // Refresh model cache in background
    fetchKiroModels().catch((e) => log(`Model fetch after login failed: ${e.message}`));

    // Redirect to main dashboard
    res.writeHead(302, { Location: `/` });
    res.end();
  } catch (err) {
    log(`OAuth callback error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h2>Error: ${err.message}</h2></body></html>`);
  }
}

function startCallbackServer() {
  if (callbackServer) return;
  callbackServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`);
    if (url.pathname === '/oauth/callback') {
      await handleOAuthCallback(url, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  callbackServer.listen(OAUTH_CALLBACK_PORT, () => {
    log(`OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
  });
  callbackServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${OAUTH_CALLBACK_PORT} busy — callback server not started (another kiro-cli may be running)`);
      callbackServer = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  try {
    // ---- Login/logout for dashboard password ----

    if (method === 'GET' && pathname === '/login') {
      if (!DASHBOARD_PASSWORD) { sendRedirect(res, '/'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getLoginPageHtml());
      return;
    }

    if (method === 'POST' && pathname === '/login') {
      if (!DASHBOARD_PASSWORD) { sendRedirect(res, '/'); return; }
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const password = params.get('password') || '';

      if (password === DASHBOARD_PASSWORD) {
        const token = generateSessionToken();
        activeSessions.add(token);
        // Auto-expire session
        setTimeout(() => activeSessions.delete(token), SESSION_MAX_AGE * 1000);
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
        });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getLoginPageHtml('Incorrect password'));
      }
      return;
    }

    // ---- Dashboard auth gate ----
    // /v1/* routes use API key auth (not dashboard password)
    // All other routes (dashboard, /api/*, /auth/*) require dashboard password
    if (DASHBOARD_PASSWORD && !pathname.startsWith('/v1/') && pathname !== '/login') {
      if (!isDashboardAuthenticated(req)) {
        sendRedirect(res, '/login');
        return;
      }
    }

    // ---- Dashboard routes ----

    if (method === 'GET' && pathname === '/') {
      // Serve dashboard.html
      const dashboardPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'dashboard.html');
      try {
        const html = await readFile(dashboardPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(html);
      } catch {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('<html><body><h1>Kiro Gateway</h1><p>dashboard.html not found. <a href="/auth/google">Login with Google</a></p></body></html>');
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/status') {
      // Auto-fetch models if authenticated but cache is empty
      if (credentials?.accessToken && !cachedModels) {
        try { await fetchKiroModels(); } catch { /* ignore */ }
      }
      const models = cachedModels || [];
      sendJSON(res, 200, {
        authenticated: !!credentials?.accessToken,
        email: credentials?.email || null,
        expiresAt: credentials?.expiresAt || null,
        modelsCount: models.length,
        apiKey: PROXY_API_KEY,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/models') {
      // Auto-fetch if cache is empty
      if (credentials?.accessToken && !cachedModels) {
        try { await fetchKiroModels(); } catch { /* ignore */ }
      }
      sendJSON(res, 200, cachedModels || []);
      return;
    }

    // ---- OAuth routes ----

    if (method === 'GET' && pathname === '/auth/google') {
      const { verifier, challenge } = generatePKCE();
      const state = crypto.randomBytes(16).toString('hex');
      pkceStore.set(state, verifier);

      // Clean up old states after 10 minutes
      setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

      // Use Kiro auth service /login endpoint (not Cognito directly)
      // Format: /login?idp=Google&redirect_uri=...&code_challenge=...&code_challenge_method=S256&state=...
      const params = new URLSearchParams({
        idp: 'Google',
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      });

      const authUrl = `${KIRO_AUTH_BASE}/login?${params.toString()}`;
      log(`OAuth redirect: ${authUrl}`);
      sendRedirect(res, authUrl);
      return;
    }

    // /oauth/callback is handled by the separate callback server on port 3128

    // Remote auth fallback: user pastes the callback URL from their browser
    if (method === 'POST' && pathname === '/api/auth/callback-url') {
      try {
        const body = await readBody(req);
        const { url: callbackUrl } = JSON.parse(body);
        if (!callbackUrl) {
          sendJSON(res, 400, { error: { message: 'Missing url field' } });
          return;
        }

        const parsed = new URL(callbackUrl);
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        const error = parsed.searchParams.get('error');

        if (error) {
          sendJSON(res, 400, { error: { message: `OAuth error: ${error}` } });
          return;
        }
        if (!code || !state) {
          sendJSON(res, 400, { error: { message: 'URL missing code or state parameter. Make sure you copied the full URL.' } });
          return;
        }

        const verifier = pkceStore.get(state);
        if (!verifier) {
          sendJSON(res, 400, { error: { message: 'State not found or expired. Start the login flow again.' } });
          return;
        }
        pkceStore.delete(state);

        const tokenBody = JSON.stringify({
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        });

        const tokenRes = await httpsRequest(`${KIRO_AUTH_BASE}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': `KiroIDE-0.7.45-${FINGERPRINT}`,
          },
          body: tokenBody,
        });

        if (tokenRes.statusCode !== 200) {
          log(`Token exchange failed: ${tokenRes.statusCode} ${tokenRes.body.toString()}`);
          sendJSON(res, 502, { error: { message: `Token exchange failed (${tokenRes.statusCode}). The code may have expired — try again.` } });
          return;
        }

        const tokenData = JSON.parse(tokenRes.body.toString());

        credentials = {
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: Date.now() + (tokenData.expiresIn || 3600) * 1000,
          email: tokenData.email || null,
          profileArn: null,
        };

        await saveCredentials();
        log(`Authenticated as ${credentials.email} (via pasted callback URL)`);
        fetchKiroModels().catch((e) => log(`Model fetch after login failed: ${e.message}`));

        sendJSON(res, 200, { ok: true, email: credentials.email });
      } catch (err) {
        log(`Callback URL parse error: ${err.message}`);
        sendJSON(res, 400, { error: { message: `Invalid URL: ${err.message}` } });
      }
      return;
    }

    if ((method === 'GET' || method === 'POST') && pathname === '/auth/logout') {
      credentials = null;
      cachedModels = null;
      modelsLastFetched = 0;
      try {
        await writeFile(CREDENTIALS_PATH, '{}');
      } catch { /* ignore */ }
      log('Logged out');
      sendRedirect(res, '/');
      return;
    }

    // ---- OpenAI-compatible API routes (require API key) ----

    if (pathname.startsWith('/v1/')) {
      if (!checkApiKey(req)) {
        sendJSON(res, 401, {
          error: { message: 'Invalid or missing API key', type: 'authentication_error' },
        });
        return;
      }

      if (!credentials?.accessToken) {
        sendJSON(res, 503, {
          error: {
            message: 'Gateway not authenticated. Visit the dashboard to sign in.',
            type: 'service_unavailable',
          },
        });
        return;
      }

      // GET /v1/models
      if (method === 'GET' && pathname === '/v1/models') {
        try {
          const models = await fetchKiroModels();
          const ts = Math.floor(Date.now() / 1000);
          sendJSON(res, 200, {
            object: 'list',
            data: models.map((m) => ({
              id: m.modelId || m.id || 'unknown',
              object: 'model',
              created: ts,
              owned_by: 'kiro',
            })),
          });
        } catch (e) {
          log(`/v1/models error: ${e.message}`);
          sendJSON(res, 502, {
            error: { message: e.message, type: 'upstream_error' },
          });
        }
        return;
      }

      // POST /v1/chat/completions
      if (method === 'POST' && pathname === '/v1/chat/completions') {
        const body = await readBody(req);
        try {
          await handleChatCompletions(req, res, body);
        } catch (e) {
          log(`/v1/chat/completions error: ${e.message}`);
          if (!res.headersSent) {
            sendJSON(res, 500, {
              error: { message: e.message, type: 'server_error' },
            });
          }
        }
        return;
      }

      // Unknown /v1 route
      sendJSON(res, 404, {
        error: { message: `Unknown endpoint: ${method} ${pathname}`, type: 'not_found' },
      });
      return;
    }

    // ---- 404 ----
    sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });

  } catch (err) {
    log(`Unhandled error: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: { message: 'Internal server error', type: 'server_error' } });
    }
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function main() {
  log('Starting Kiro Gateway...');

  // Load saved credentials
  await loadCredentials();

  // Pre-fetch models if authenticated
  if (credentials?.accessToken) {
    fetchKiroModels().catch((e) => log(`Initial model fetch failed: ${e.message}`));
  }

  const server = createServer(handleRequest);

  server.listen(PORT, '0.0.0.0', () => {
    log(`Listening on http://0.0.0.0:${PORT}`);
    log(`Dashboard: http://localhost:${PORT}/`);
    log(`API: http://localhost:${PORT}/v1/chat/completions`);
    log(`Models: http://localhost:${PORT}/v1/models`);
    if (credentials?.accessToken) {
      log(`Authenticated as: ${credentials.email || 'Google user'} (token expires: ${new Date(credentials.expiresAt).toISOString()})`);
    } else {
      log('Not authenticated. Visit the dashboard to sign in.');
    }
  });

  // Start OAuth callback server on port 3128 (Cognito-registered redirect URI)
  startCallbackServer();

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down...');
    if (callbackServer) callbackServer.close();
    server.close(() => process.exit(0));
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
