# DS009 -- Error Handling

## Summary

This specification describes the error class hierarchy, retry logic with exponential backoff, error classification system, and the rules governing when errors trigger cooldowns, cascades, or immediate failure.

## Problem

Soul Gateway interacts with multiple upstream providers that fail in different ways: network timeouts, rate limits, authentication failures, model-not-found errors, payment-required errors, and internal server errors. The system must classify these errors, decide which are retryable, compute appropriate backoff delays, and determine whether to retry the same model, cascade to a different model, or fail immediately.

## Design

### Error Class Hierarchy

All Soul Gateway errors extend `SoulGatewayError`, which extends the built-in `Error`:

```
Error
  SoulGatewayError (status, type)
    AuthError               -- 401, 'authentication_error'
    RateLimitError          -- 429, 'rate_limit_error', retryAfter
    BlacklistError          -- 400, 'content_blocked', ruleId, match
    ModelNotFoundError      -- 404, 'model_not_found'
    LoopDetectedError       -- 429, 'loop_detected', retryAfter=30, pattern
    BudgetExceededError     -- 429, 'budget_exceeded', retryAfter, scope, spent, budget
    QueueTimeoutError       -- 503, 'queue_timeout', retryAfter=10
    UpstreamError           -- 502, 'upstream_error' (default)
```

Each error carries:
- `status`: HTTP status code for the response
- `type`: Machine-readable error type string
- `retryAfter` (optional): seconds for the Retry-After header

### Error Response Format

All errors are returned to clients in OpenAI-compatible format:

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded: 61/60 RPM for this API key"
  }
}
```

Rate-limit, budget, queue-timeout, and loop-detected errors include a `Retry-After` HTTP header.

### Retry Logic

`dispatchWithRetry()` in `retry.mjs` implements per-provider retry:

**Retry loop:**

```
for attempt = 0..maxRetries (3):
  try:
    dispatch upstream
    peek at first chunk (validates generator works)
    return generator (prepending the peeked chunk)
  catch:
    classify error
    if managed auth + quota error -> rotate account, retry
    if non-retryable or attempts exhausted -> throw
    compute delay, sleep, retry
```

**Timeout:** Each attempt has a 120-second abort timeout via `AbortController`.

**First-chunk peek:** The generator's first `.next()` is called immediately to verify the connection works. If the provider fails on connection (auth error, timeout, DNS failure), this throws synchronously before any SSE data is sent to the client. Once chunks start flowing, mid-stream errors are handled by `stream-tap.mjs` (not retried).

### Exponential Backoff

```javascript
function computeDelay(attempt) {
  const base = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  const capped = Math.min(base, maxDelayMs);
  const jitter = capped * (jitterPercent / 100) * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(capped + jitter));
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `initialDelayMs` | 1,000 | First retry delay |
| `backoffMultiplier` | 2 | Exponential multiplier |
| `maxDelayMs` | 30,000 | Maximum delay cap |
| `jitterPercent` | 20 | Random jitter range (+/- 20%) |

**Delay sequence (without jitter):** 1s, 2s, 4s (capped at 30s for higher attempts).

### Error Classification

`classifyProviderError()` and `classifyError()` in `upstream-dispatch.mjs` classify upstream errors by HTTP status:

| Status | Classification | Retryable | Triggers Cooldown | Triggers Cascade |
|--------|---------------|-----------|-------------------|-----------------|
| 400 | bad_request | No | No | Yes |
| 401 | authentication_error | No | No | Yes |
| 402 | payment_required | No | Yes | Yes |
| 403 | forbidden | No | No | Yes |
| 404 | not_found | No | No | Yes |
| 429 | rate_limit_error | Yes | Yes | Yes |
| 500 | server_error | Yes | No | Yes |
| 502 | upstream_error | Yes | No | Yes |
| 503 | service_unavailable | Yes | No | Yes |
| 0/timeout | connection_error | Yes | No | Yes |

**Critical flag:** 401 and 403 errors set `classification.critical = true`, triggering a provider authentication failure log.

**Max retries override:** Some classifications can override `maxRetries` (e.g., limiting auth errors to 0 retries).

### Account Rotation on Quota Errors

For managed-auth providers (`dbConfig.auth_type === 'managed'`), when a dispatch fails with status 402 or `payment_required` classification:

1. Call `authManager.rotateAccount(providerName)`
2. If rotation succeeds, add a retry detail entry with `error_type: 'account_rotation'` and retry immediately (no delay)
3. If all accounts are exhausted, throw `quota_exhausted` error (429)

This is handled in `retry.mjs` before the standard retry classification logic.

### Cooldown Triggers

From `config.mjs`:

```javascript
cooldownTriggers: ['payment_required', 'rate_limit_error']
```

When `shouldTriggerCooldown(errorClassification)` returns true, the pipeline (in `pipeline.mjs`) calls `putModelInCooldown()` and then re-resolves the tier to try the next model.

### Cascade Rules

`shouldCascade(errorClassification)` returns true for **any** classified error -- if the upstream provider returned a classifiable error, it means the model/provider failed and a different model might succeed. This covers:

- Bad request errors (model-specific validation)
- Not-found errors (model removed from provider)
- Auth errors (provider key revoked)
- Server errors (provider outage)

The difference from cooldown is that cascade does not place the model in cooldown -- it simply tries the next model in the tier for this request only.

### Retries Detail

The pipeline records a `retries_detail` JSONB array in `call_logs`:

```json
[
  { "attempt": 1, "status": 429, "error_type": "rate_limit_error", "delay_ms": 1000 },
  { "attempt": 2, "status": 429, "error_type": "rate_limit_error", "delay_ms": 2000 }
]
```

This provides full visibility into what happened during retry sequences.

## Implementation

| File | Role |
|------|------|
| `utils/errors.mjs` | Error class hierarchy |
| `pipeline/retry.mjs` | `dispatchWithRetry()`, backoff computation, account rotation |
| `pipeline/upstream-dispatch.mjs` | `classifyProviderError()`, `classifyError()` |
| `pipeline/model-cooldown.mjs` | `shouldTriggerCooldown()`, `shouldCascade()`, `putModelInCooldown()` |
| `pipeline/pipeline.mjs` | Model-level retry loop, error catch block |
| `config.mjs` | Retry and cooldown configuration |

## Dependencies

- DS001 (Request Pipeline) -- pipeline catch block and model retry loop
- DS002 (Provider Auth) -- account rotation on quota errors
- DS004 (Model Routing) -- cooldown and cascade feed into model re-resolution
- DS007 (Rate Limiting & Budgets) -- RateLimitError and BudgetExceededError
