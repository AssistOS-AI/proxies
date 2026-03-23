import { query } from '../db/init.mjs';
import { RateLimitError } from '../utils/errors.mjs';

const WINDOW_MS = 60_000;

export async function checkRateLimit(keyId, rpmLimit) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const rpmKey = `rpm:key:${keyId}`;

  const { rows } = await query(`
    INSERT INTO rate_limit_state (key, window_start, counter, updated_at)
    VALUES ($1, $2, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      counter = CASE
        WHEN rate_limit_state.window_start < $2
        THEN 1
        ELSE rate_limit_state.counter + 1
      END,
      window_start = CASE
        WHEN rate_limit_state.window_start < $2
        THEN $2
        ELSE rate_limit_state.window_start
      END,
      updated_at = now()
    RETURNING counter, window_start
  `, [rpmKey, windowStart]);

  const { counter } = rows[0];
  if (counter > rpmLimit) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    throw new RateLimitError(
      `Rate limit exceeded: ${counter}/${rpmLimit} RPM for this API key`,
      retryAfter
    );
  }
}
