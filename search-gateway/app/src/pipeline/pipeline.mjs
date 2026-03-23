import { authenticate } from './auth.mjs';
import { checkRateLimit } from './rate-limiter.mjs';
import { extractQuery } from './query-extractor.mjs';
import { resolveSearchModel } from './search-router.mjs';
import { formatResultsMarkdown, wrapInChatCompletion } from './result-formatter.mjs';
import { streamResponse } from './stream-tap.mjs';
import { createProvider } from '../providers/registry.mjs';
import { incrementUsage, checkQuota } from '../db/providers-dao.mjs';
import { insertLog } from '../db/logs-dao.mjs';
import { sendJson, sendError } from '../utils/http-helpers.mjs';
import { SearchGatewayError, QuotaExceededError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('pipeline');

/**
 * Main request pipeline for /v1/chat/completions.
 */
export async function pipeline(req, res, body) {
  const startedAt = new Date();
  const logEntry = {
    started_at: startedAt,
    is_streaming: false,
    status_code: 200,
  };

  try {
    // 1. Authenticate
    const auth = await authenticate(req);
    logEntry.api_key_id = auth.api_key_id;

    // 2. Agent identification
    logEntry.agent_name = req.headers['x-soul-agent'] || null;

    // 3. Parse body
    const { model, messages, stream } = body;
    if (!model) return sendError(res, 400, 'model is required');
    if (!messages || !Array.isArray(messages)) return sendError(res, 400, 'messages array is required');
    logEntry.requested_model = model;
    logEntry.is_streaming = !!stream;
    logEntry.request_messages = messages;

    // 4. Rate limit
    await checkRateLimit(auth.api_key_id, auth.rpm_limit);

    // 5. Extract query
    const { query: searchQuery, params: searchParams } = extractQuery(messages);
    if (!searchQuery) return sendError(res, 400, 'Could not extract search query from messages');
    logEntry.search_query = searchQuery;
    logEntry.search_params = searchParams;

    // 6. Route to model/provider
    const route = await resolveSearchModel(model);
    logEntry.resolved_provider = route.providerType;

    // 7. Handle deep-research separately
    if (route.providerType === 'research') {
      // Deep research is handled in Phase 5 — for now return a placeholder
      const { handleDeepResearch } = await import('./deep-research.mjs');
      return await handleDeepResearch(req, res, searchQuery, searchParams, route, logEntry, stream);
    }

    // 8. Check provider quota
    if (route.provider && !await checkQuota(route.provider)) {
      throw new QuotaExceededError(
        route.provider.name,
        route.provider.monthly_usage,
        route.provider.monthly_quota
      );
    }

    // 9. Dispatch to search provider
    const provider = createProvider(route.providerType, route.apiKey, route.baseUrl, route.providerConfig);
    const results = await provider.search(searchQuery, { ...route.modelConfig, ...searchParams });
    logEntry.result_count = results.length;

    // Track usage
    if (route.provider) {
      await incrementUsage(route.provider.id).catch(err => log.warn('Usage tracking failed', { error: err.message }));
    }

    // 10. Format and respond
    const latencyMs = Date.now() - startedAt.getTime();
    logEntry.latency_ms = latencyMs;

    const markdown = formatResultsMarkdown(results, searchQuery, route.provider?.display_name || route.providerType, latencyMs);
    logEntry.response_content = markdown;

    if (stream) {
      streamResponse(res, markdown, model);
    } else {
      const response = wrapInChatCompletion(markdown, model);
      sendJson(res, response);
    }

    // Log success
    logEntry.completed_at = new Date();
    await insertLog(logEntry).catch(err => log.error('Log insert failed', { error: err.message }));

  } catch (err) {
    const latencyMs = Date.now() - startedAt.getTime();
    logEntry.latency_ms = latencyMs;
    logEntry.completed_at = new Date();

    if (err instanceof SearchGatewayError) {
      logEntry.status_code = err.status;
      logEntry.error_type = err.type;
      logEntry.error_message = err.message;

      const headers = {};
      if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
      sendError(res, err.status, err.message, err.type);
    } else {
      logEntry.status_code = 500;
      logEntry.error_type = 'internal_error';
      logEntry.error_message = err.message;
      log.error('Pipeline error', { error: err.message, stack: err.stack });
      sendError(res, 500, 'Internal server error');
    }

    await insertLog(logEntry).catch(e => log.error('Log insert failed', { error: e.message }));
  }
}
