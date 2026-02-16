import { createLogger } from '../utils/logger.mjs';

const log = createLogger('ws-logs');

/** @type {Set<{ws: object, filters: object}>} */
const subscribers = new Set();

/**
 * Handle a new WebSocket connection for /ws/v1/logs.
 */
export function handleLogStream(ws, query) {
  const filters = {
    family_id: query.family_id || null,
    soul_id: query.soul_id || null,
    model: query.model || null,
  };

  const sub = { ws, filters };
  subscribers.add(sub);
  log.info('Log stream subscriber connected', { filters, total: subscribers.size });

  ws.send(JSON.stringify({ type: 'connected', filters }));

  // Allow filter updates via message
  ws.onMessage = (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'filter') {
        sub.filters = { ...sub.filters, ...data.filters };
        ws.send(JSON.stringify({ type: 'filter_updated', filters: sub.filters }));
      }
    } catch { /* ignore invalid messages */ }
  };

  ws.onClose = () => {
    subscribers.delete(sub);
    log.info('Log stream subscriber disconnected', { total: subscribers.size });
  };
}

/**
 * Broadcast a log entry to all matching subscribers.
 */
export function broadcastLog(logEntry) {
  const payload = JSON.stringify({ type: 'log', data: sanitizeForBroadcast(logEntry) });

  for (const sub of subscribers) {
    if (!sub.ws.alive) {
      subscribers.delete(sub);
      continue;
    }
    if (matchesFilters(logEntry, sub.filters)) {
      sub.ws.send(payload);
    }
  }
}

function matchesFilters(entry, filters) {
  if (filters.family_id && entry.family_id !== filters.family_id) return false;
  if (filters.soul_id && entry.soul_id !== filters.soul_id) return false;
  if (filters.model && entry.resolved_model !== filters.model) return false;
  return true;
}

function sanitizeForBroadcast(entry) {
  // Send a lighter version without full prompt/response content
  return {
    id: entry.id,
    family_id: entry.family_id,
    family_name: entry.family_name,
    soul_id: entry.soul_id,
    requested_model: entry.requested_model,
    resolved_model: entry.resolved_model,
    mode: entry.mode,
    is_streaming: entry.is_streaming,
    status_code: entry.status_code,
    stop_reason: entry.stop_reason,
    error_type: entry.error_type,
    error_message: entry.error_message,
    latency_ms: entry.latency_ms,
    ttfb_ms: entry.ttfb_ms,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    total_tokens: entry.total_tokens,
    total_cost: entry.total_cost,
    retry_count: entry.retry_count,
    blocked_by_blacklist: entry.blocked_by_blacklist,
    is_truncated: entry.is_truncated,
    is_slow: entry.is_slow,
    prompt_size_warning: entry.prompt_size_warning,
    started_at: entry.started_at,
    completed_at: entry.completed_at,
  };
}
