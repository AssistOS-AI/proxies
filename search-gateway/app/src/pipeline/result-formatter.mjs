import { randomUUID } from 'node:crypto';

/**
 * Format SearchResult[] into markdown string.
 */
export function formatResultsMarkdown(results, query, providerName, latencyMs) {
  if (!results || results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const lines = [`## Search Results for: "${query}"\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title || 'Untitled';
    const url = r.url || '';
    const snippet = r.snippet || r.content?.slice(0, 300) || '';

    lines.push(`### ${i + 1}. [${title}](${url})`);
    if (snippet) lines.push(snippet);
    const meta = [];
    if (r.source) meta.push(`**Source:** ${r.source}`);
    if (r.published_date) meta.push(`**Published:** ${r.published_date}`);
    if (meta.length) lines.push(meta.join(' | '));
    lines.push('');
  }

  lines.push('---');
  lines.push(`*${results.length} results from ${providerName} | ${latencyMs}ms*`);

  return lines.join('\n');
}

/**
 * Wrap markdown content in OpenAI chat completion response format.
 */
export function wrapInChatCompletion(content, model) {
  return {
    id: `search-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}
