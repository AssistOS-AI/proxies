import { config } from '../config.mjs';
import { sendJson, sendError, corsHeaders } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('proxy:completions');

export async function handleCompletions(body, req, res, headers) {
  const response = await fetch(`${config.copilotBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Check for unsupported_api_for_model before committing to a response
  if (response.status === 400) {
    const data = await response.json().catch(() => null);
    const errorMsg = data?.error?.message || data?.message || '';
    if (errorMsg.includes('unsupported_api_for_model')) {
      const err = new Error('unsupported_api_for_model');
      err.code = 'UNSUPPORTED_API_FOR_MODEL';
      throw err;
    }
    return sendJson(res, data, 400);
  }

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
}
