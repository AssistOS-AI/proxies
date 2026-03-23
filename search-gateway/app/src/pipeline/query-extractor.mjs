/**
 * Extract search query and params from OpenAI-format messages.
 * Strategy:
 * 1. Take last user message content
 * 2. Try JSON.parse — if has `query` field, use structured mode
 * 3. Otherwise use raw text as query
 */
export function extractQuery(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { query: '', params: {} };
  }

  // Find last user message
  let lastUserContent = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      lastUserContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : '';
      break;
    }
  }

  if (!lastUserContent.trim()) {
    return { query: '', params: {} };
  }

  // Try structured JSON mode
  try {
    const parsed = JSON.parse(lastUserContent);
    if (parsed && typeof parsed.query === 'string') {
      const { query, ...params } = parsed;
      return { query: query.trim(), params };
    }
  } catch {
    // Not JSON, use as plain text
  }

  return { query: lastUserContent.trim(), params: {} };
}
