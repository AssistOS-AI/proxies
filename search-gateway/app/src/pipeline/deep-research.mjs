import { createProvider } from '../providers/registry.mjs';
import { formatResultsMarkdown, wrapInChatCompletion } from './result-formatter.mjs';
import { streamResponse, streamProgress } from './stream-tap.mjs';
import { sendJson } from '../utils/http-helpers.mjs';
import { insertLog } from '../db/logs-dao.mjs';
import { query } from '../db/init.mjs';
import { decrypt } from '../utils/crypto.mjs';
import { corsHeaders } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('deep-research');

/**
 * Handle deep-research model requests.
 * Phase 5 will add LLM-assisted query decomposition and synthesis.
 * For now: search across all enabled providers and merge results.
 */
export async function handleDeepResearch(req, res, searchQuery, searchParams, route, logEntry, stream) {
  const startedAt = logEntry.started_at;

  // Get all enabled search providers
  const { rows: providers } = await query(`
    SELECT * FROM search_providers WHERE is_enabled = true ORDER BY sort_order ASC
  `);

  if (providers.length === 0) {
    const content = `No search providers configured for deep research.`;
    if (stream) {
      streamResponse(res, content, 'deep-research');
    } else {
      sendJson(res, wrapInChatCompletion(content, 'deep-research'));
    }
    logEntry.status_code = 200;
    logEntry.result_count = 0;
    logEntry.response_content = content;
    logEntry.completed_at = new Date();
    logEntry.latency_ms = Date.now() - startedAt.getTime();
    await insertLog(logEntry).catch(e => log.error('Log insert failed', { error: e.message }));
    return;
  }

  // Set up streaming headers if needed
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(),
    });
    streamProgress(res, `Searching across ${providers.length} providers...\n\n`, 'deep-research');
  }

  // Search all providers in parallel
  const allResults = [];
  const subQueries = [{ query: searchQuery, providers: [] }];

  const searchPromises = providers.map(async (prov) => {
    try {
      let apiKey = null;
      if (prov.encrypted_api_key) {
        apiKey = decrypt(prov.encrypted_api_key);
      }
      const provider = createProvider(prov.provider_type, apiKey, prov.base_url, prov.config || {});
      const results = await provider.search(searchQuery, searchParams);
      subQueries[0].providers.push(prov.name);

      if (stream) {
        streamProgress(res, `Found ${results.length} results from ${prov.display_name}\n`, 'deep-research');
      }

      return results.map(r => ({ ...r, _provider: prov.display_name }));
    } catch (err) {
      log.warn(`Deep research: ${prov.name} failed`, { error: err.message });
      if (stream) {
        streamProgress(res, `${prov.display_name}: search failed (${err.message})\n`, 'deep-research');
      }
      return [];
    }
  });

  const providerResults = await Promise.all(searchPromises);
  for (const results of providerResults) {
    allResults.push(...results);
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = allResults.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  const latencyMs = Date.now() - startedAt.getTime();
  const markdown = formatResultsMarkdown(deduped, searchQuery, `${providers.length} providers`, latencyMs);

  if (stream) {
    streamProgress(res, `\n---\n\n${markdown}`, 'deep-research');
    // Send done
    const { randomUUID } = await import('node:crypto');
    const done = {
      id: `search-${randomUUID()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deep-research',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(done)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    sendJson(res, wrapInChatCompletion(markdown, 'deep-research'));
  }

  // Log
  logEntry.status_code = 200;
  logEntry.result_count = deduped.length;
  logEntry.response_content = markdown;
  logEntry.sub_query_count = 1;
  logEntry.sub_queries = subQueries;
  logEntry.completed_at = new Date();
  logEntry.latency_ms = latencyMs;
  await insertLog(logEntry).catch(e => log.error('Log insert failed', { error: e.message }));
}
