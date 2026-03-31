# DS007 -- Rate Limiting & Budgets

## Summary

This specification describes the per-key rate limiting system (RPM and TPM), budget enforcement (daily and monthly), and the cost calculation formula used by Soul Gateway.

## Problem

Without rate limiting, a single client can monopolize upstream provider capacity or trigger provider-level rate limits that affect all clients. Without budget enforcement, costs can spiral out of control. The system needs per-key controls for both request rate and cost.

## Design

### RPM Rate Limiting

Rate limiting uses a 60-second sliding window implemented in PostgreSQL via the `rate_limit_state` table. This approach survives process restarts (unlike in-memory counters).

**Check flow** (`checkRateLimit()` in `rate-limiter.mjs`):

1. Compute window start: `now - 60,000ms`
2. Upsert into `rate_limit_state` with key `rpm:key:{keyId}`:
   - If the stored `window_start` is older than the current window, reset counter to 1
   - Otherwise, increment counter
3. If counter exceeds `rpmLimit`, throw `RateLimitError` (429) with `Retry-After: 60`

**SQL implementation:**

```sql
INSERT INTO rate_limit_state (key, window_start, counter, updated_at)
VALUES ($1, $2, 1, now())
ON CONFLICT (key) DO UPDATE SET
  counter = CASE
    WHEN rate_limit_state.window_start < $2 THEN 1
    ELSE rate_limit_state.counter + 1
  END,
  window_start = CASE
    WHEN rate_limit_state.window_start < $2 THEN $2
    ELSE rate_limit_state.window_start
  END,
  updated_at = now()
RETURNING counter, window_start
```

This is an atomic upsert that handles both new keys and window resets in a single query.

### TPM Tracking

Token-per-minute tracking (`trackTokenUsage()`) uses the same sliding window mechanism with key `tpm:key:{keyId}`, but instead of incrementing by 1, it increments by the number of tokens used. TPM is tracked **post-response** (after token count is known) so it cannot pre-block requests, but it logs warnings when the limit is exceeded.

### Default Limits

From `config.mjs`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `defaultRpmLimit` | 60 | Requests per minute per key |
| `defaultTpmLimit` | 100,000 | Tokens per minute per key |

Per-key overrides are stored in `api_keys.rpm_limit` and `api_keys.tpm_limit`.

### Cost Calculation

`calculateCost()` in `cost-calculator.mjs` supports two pricing models:

**Token-priced models** (`pricingType === 'token'`):

```
input_cost  = (prompt_tokens / 1,000,000) * input_price
output_cost = (completion_tokens / 1,000,000) * output_price
total_cost  = input_cost + output_cost
```

**Request-priced models** (`pricingType === 'request'`):

```
input_cost  = 0
output_cost = 0
total_cost  = request_cost
```

All costs are rounded to 6 decimal places (`Math.round(cost * 1,000,000) / 1,000,000`).

The function returns:

```javascript
{
  prompt_tokens,
  completion_tokens,
  total_tokens,
  input_cost,
  output_cost,
  total_cost,
}
```

### Budget Enforcement

Budget enforcement is implemented as a middleware (budget-tracker) rather than in the core pipeline. This allows it to be enabled/disabled per model or tier.

**Daily budget** (`api_keys.daily_budget`, default $2):

- Pre-dispatch: query sum of `total_cost` from `call_logs` where `api_key_id` matches and `started_at` is within the current UTC day
- If spent >= budget, abort with `BudgetExceededError` (429)

**Monthly budget** (`api_keys.monthly_budget`, default NULL = unlimited):

- Pre-dispatch: query sum of `total_cost` from `call_logs` where `api_key_id` matches and `started_at` is within the current UTC month
- If spent >= budget, abort with `BudgetExceededError` (429)

**Free model bypass**: requests resolved to models with `is_free = true` skip budget tracking entirely.

**Post-dispatch**: after cost calculation, the running budget total is updated in the middleware metadata for accurate intra-request tracking.

### BudgetExceededError

```javascript
class BudgetExceededError extends SoulGatewayError {
  constructor(scope, spent, budget) {
    // Retry-After: min(seconds until next month, 86400)
    super(`Monthly budget exceeded for ${scope}: $${spent} / $${budget}`, 429, 'budget_exceeded');
    this.retryAfter = /* seconds until reset */;
  }
}
```

## Implementation

| File | Role |
|------|------|
| `pipeline/rate-limiter.mjs` | `checkRateLimit()`, `trackTokenUsage()` |
| `pipeline/cost-calculator.mjs` | `calculateCost()` |
| `middlewares/budget-tracker.mjs` | Budget enforcement middleware |
| `utils/errors.mjs` | `RateLimitError`, `BudgetExceededError` |
| `config.mjs` | Default RPM/TPM limits |
| `db/schema.sql` | `rate_limit_state` table |

## Dependencies

- DS001 (Request Pipeline) -- rate limit check after auth, cost calculation after dispatch
- DS003 (Middleware Framework) -- budget enforcement runs as a middleware
- DS006 (Database Schema) -- rate_limit_state table, call_logs for budget queries
- DS009 (Error Handling) -- RateLimitError and BudgetExceededError classes
