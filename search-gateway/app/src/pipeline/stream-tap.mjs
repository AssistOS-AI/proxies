import { randomUUID } from 'node:crypto';
import { corsHeaders } from '../utils/http-helpers.mjs';

/**
 * Send search results as SSE stream (OpenAI streaming format).
 */
export function streamResponse(res, content, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders(),
  });

  const id = `search-${randomUUID()}`;

  // Send content as a single delta chunk
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content },
      finish_reason: null,
    }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  // Send done chunk
  const done = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Send a progress message in SSE format (for deep-research steps).
 */
export function streamProgress(res, message, model) {
  const chunk = {
    id: `search-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content: message },
      finish_reason: null,
    }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
