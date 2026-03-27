import { config } from '../config.mjs';
import { sendJson, sendError, corsHeaders } from '../utils/http-helpers.mjs';
import { parseSSEStream } from '../utils/sse.mjs';
import { convertToResponsesPayload, convertToCompletionsResponse, convertStreamChunk } from './endpoint-router.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('proxy:responses');

/**
 * Direct passthrough to the Responses API.
 * Used when the request comes in on /v1/responses.
 */
export async function handleResponsesDirect(body, req, res, headers) {
  try {
    const response = await fetch(`${config.copilotBaseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!body.stream) {
      const data = await response.json();
      return sendJson(res, data, response.status);
    }

    // Check upstream status before committing to streaming
    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: { message: `Upstream error (${response.status})` } }));
      return sendJson(res, data, response.status);
    }

    // Streaming: pipe upstream SSE through to client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(),
    });

    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err) {
    log.error('Responses direct proxy error', { error: err.message });
    sendError(res, 502, `Upstream responses error: ${err.message}`);
  }
}

/**
 * Translated proxy: receives a Chat Completions request, converts to Responses API,
 * sends upstream, then converts the response back to Chat Completions format.
 */
export async function handleResponsesTranslated(body, req, res, headers, requestId) {
  const responsesPayload = convertToResponsesPayload(body);

  let response;
  try {
    response = await fetch(`${config.copilotBaseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(responsesPayload),
    });
  } catch (err) {
    log.error('Responses translated fetch error', { error: err.message });
    return sendError(res, 502, `Upstream responses error: ${err.message}`);
  }

  // Check for "unsupported_api_for_model" 400 error
  if (response.status === 400) {
    const data = await response.json().catch(() => null);
    const errorMsg = data?.error?.message || data?.message || '';
    if (errorMsg.includes('unsupported_api_for_model')) {
      const err = new Error('unsupported_api_for_model');
      err.code = 'UNSUPPORTED_API_FOR_MODEL';
      throw err;
    }
    // Other 400 errors: forward as-is
    return sendJson(res, data, 400);
  }

  if (!body.stream) {
    // Non-streaming: convert Responses format back to Chat Completions
    const data = await response.json();
    const result = convertToCompletionsResponse(data, requestId);
    return sendJson(res, result);
  }

  // Streaming: parse Responses API SSE, convert each chunk to Chat Completions format
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders(),
  });

  try {
    // Responses API uses event-based completion (response.completed), not [DONE] sentinel
    for await (const frame of parseSSEStream(response.body, { doneSentinel: null })) {
      const chunk = convertStreamChunk(frame, requestId);
      if (chunk !== null) {
        res.write(chunk);
      }
    }
  } catch (err) {
    log.error('Error parsing responses stream', { error: err.message });
  }

  res.end();
}
