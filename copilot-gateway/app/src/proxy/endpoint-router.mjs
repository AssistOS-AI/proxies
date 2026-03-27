const endpointCache = new Map();

/**
 * Determine which upstream endpoint a model needs: 'completions' or 'responses'.
 */
export function getEndpointForModel(modelId) {
  if (endpointCache.has(modelId)) return endpointCache.get(modelId);
  // Models containing 'codex' need the Responses API
  if (modelId.toLowerCase().includes('codex')) return 'responses';
  return 'completions';
}

/**
 * Cache the endpoint type for a model after discovery (e.g. after a 400 retry).
 */
export function cacheEndpoint(modelId, endpoint) {
  endpointCache.set(modelId, endpoint);
}

/* ---------- Format conversion: Chat Completions <-> Responses API ---------- */

const ROLE_MAP = { system: 'developer', user: 'user', assistant: 'assistant' };

/**
 * Convert a standard Chat Completions request body to a Responses API request body.
 */
export function convertToResponsesPayload(chatPayload) {
  const { messages, max_tokens, ...rest } = chatPayload;
  const input = messages.map(msg => ({
    role: ROLE_MAP[msg.role] || 'user',
    content: msg.content,
  }));
  const payload = { ...rest, input };
  if (max_tokens !== undefined) {
    payload.max_output_tokens = max_tokens;
  }
  return payload;
}

/**
 * Convert a Responses API response back to a Chat Completions response.
 */
export function convertToCompletionsResponse(responsesData, requestId) {
  // Extract text from the response
  let text = '';
  if (typeof responsesData.output_text === 'string') {
    text = responsesData.output_text;
  } else if (Array.isArray(responsesData.output)) {
    const parts = [];
    for (const item of responsesData.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
      }
    }
    text = parts.join('\n');
  }

  // Map usage
  const usage = responsesData.usage || {};
  const promptTokens = usage.input_tokens || 0;
  const completionTokens = usage.output_tokens || 0;

  return {
    id: requestId,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Convert a Responses API SSE frame to a Chat Completions SSE chunk string.
 * Returns null for events that should be skipped.
 */
export function convertStreamChunk(sseFrame, requestId) {
  const { event, parsedData } = sseFrame;

  if (event === 'response.output_text.delta') {
    const chunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: parsedData.delta },
        finish_reason: null,
      }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  if (event === 'response.completed') {
    const usage = parsedData?.response?.usage || {};
    const promptTokens = usage.input_tokens || 0;
    const completionTokens = usage.output_tokens || 0;

    const finishChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    return `data: ${JSON.stringify(finishChunk)}\n\ndata: [DONE]\n\n`;
  }

  if (event === 'response.failed' || event === 'error') {
    const errorMsg = parsedData?.error?.message || parsedData?.message || 'Unknown error';
    const errorChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: `[Error: ${errorMsg}]` },
        finish_reason: 'stop',
      }],
    };
    return `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
  }

  // All other events: skip
  return null;
}
