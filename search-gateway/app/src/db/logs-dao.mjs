import { query } from './init.mjs';

export async function insertLog(log) {
  const { rows } = await query(`
    INSERT INTO search_logs (
      api_key_id, agent_name, requested_model, resolved_provider,
      search_query, search_params, is_streaming, request_messages,
      result_count, response_content, status_code,
      error_type, error_message, latency_ms,
      sub_query_count, sub_queries, started_at, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING id
  `, [
    log.api_key_id, log.agent_name, log.requested_model, log.resolved_provider,
    log.search_query, log.search_params ? JSON.stringify(log.search_params) : null,
    log.is_streaming, log.request_messages ? JSON.stringify(log.request_messages) : null,
    log.result_count, log.response_content, log.status_code,
    log.error_type, log.error_message, log.latency_ms,
    log.sub_query_count, log.sub_queries ? JSON.stringify(log.sub_queries) : null,
    log.started_at, log.completed_at,
  ]);
  return rows[0];
}

export async function queryLogs({ model, provider, status, error_type, api_key_id, limit = 50, offset = 0, sort = 'started_at', order = 'DESC' } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (model) { conditions.push(`requested_model = $${idx++}`); params.push(model); }
  if (provider) { conditions.push(`resolved_provider = $${idx++}`); params.push(provider); }
  if (status) { conditions.push(`status_code = $${idx++}`); params.push(parseInt(status)); }
  if (error_type) { conditions.push(`error_type = $${idx++}`); params.push(error_type); }
  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const allowedSort = ['started_at', 'latency_ms', 'status_code', 'result_count'];
  const sortCol = allowedSort.includes(sort) ? sort : 'started_at';
  const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

  params.push(Math.min(limit, 200));
  params.push(offset);

  const { rows } = await query(`
    SELECT * FROM search_logs ${where}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT $${idx++} OFFSET $${idx++}
  `, params);

  return rows;
}

export async function getLogCounts({ since } = {}) {
  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { rows } = await query(`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE status_code = 200)::int as success,
      COUNT(*) FILTER (WHERE error_type IS NOT NULL)::int as errors,
      AVG(latency_ms)::int as avg_latency_ms
    FROM search_logs
    WHERE started_at > $1
  `, [sinceDate]);
  return rows[0] || { total: 0, success: 0, errors: 0, avg_latency_ms: 0 };
}
