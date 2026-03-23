import { sendJson } from '../utils/http-helpers.mjs';
import { query } from '../db/init.mjs';

export const handleMetrics = {
  async summary(req, res) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { rows } = await query(`
      SELECT
        COUNT(*)::int as total_requests,
        COUNT(*) FILTER (WHERE status_code = 200)::int as successful,
        COUNT(*) FILTER (WHERE error_type IS NOT NULL)::int as errors,
        AVG(latency_ms)::int as avg_latency_ms,
        COUNT(DISTINCT requested_model)::int as models_used,
        COUNT(DISTINCT resolved_provider)::int as providers_used
      FROM search_logs
      WHERE started_at > $1
    `, [since]);
    sendJson(res, rows[0] || {});
  },

  async providers(req, res) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { rows } = await query(`
      SELECT
        resolved_provider as provider,
        COUNT(*)::int as requests,
        COUNT(*) FILTER (WHERE status_code = 200)::int as successful,
        COUNT(*) FILTER (WHERE error_type IS NOT NULL)::int as errors,
        AVG(latency_ms)::int as avg_latency_ms,
        AVG(result_count)::int as avg_results
      FROM search_logs
      WHERE started_at > $1 AND resolved_provider IS NOT NULL
      GROUP BY resolved_provider
      ORDER BY requests DESC
    `, [since]);
    sendJson(res, rows);
  },

  async errors(req, res) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { rows } = await query(`
      SELECT
        error_type,
        COUNT(*)::int as count,
        resolved_provider as provider,
        MAX(error_message) as sample_message
      FROM search_logs
      WHERE started_at > $1 AND error_type IS NOT NULL
      GROUP BY error_type, resolved_provider
      ORDER BY count DESC
    `, [since]);
    sendJson(res, rows);
  },
};
