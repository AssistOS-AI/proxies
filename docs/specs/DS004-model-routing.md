# DS004 -- Model Routing

## Summary

This specification describes the model resolution algorithm that maps a requested model name to a concrete upstream provider and model, including tier-based fallback, cooldown management, concurrency control, and pricing lookup.

## Problem

Clients request models by name (e.g., `axl/copilot/gpt-4o`, `fast-tier`), but upstream dispatch needs a specific provider key, provider model, base URL, and pricing information. The routing system must handle direct model lookups, tier-based priority resolution with fallback chains, transient error cooldowns, and per-model concurrency limits.

## Design

### Resolution Algorithm

`resolveModel(requestedModel)` follows a three-step resolution process:

**Step 1: Direct Lookup**

Query `model_configs` by name. If found and `type !== 'tier'` and `is_enabled === true`, return the model info directly via `buildModelInfo()`.

**Step 2: Tier-Based Lookup**

If no direct match (or the entry is of type `tier`), treat the requested name as a tier and call `resolveFromTier()`:

1. Look up the tier in `model_configs` where `type = 'tier'`
2. If tier is disabled, return null
3. Iterate through `model_refs` (ordered priority list of model names)
4. Skip models that are in cooldown (`isModelInCooldown()`)
5. For each model, look up in `model_configs` -- if enabled and has provider_key + provider_model, return it
6. If no model available, follow `fallback_model` to the next tier (with cycle detection via visited set)

**Step 3: Error**

If neither direct nor tier resolution succeeds, throw `ModelNotFoundError` (404).

### Model Info Object

`buildModelInfo()` constructs the return value:

```javascript
{
  resolvedModel: 'fast-tier',            // Original requested name
  modelConfigName: 'axl/copilot/gpt-4o', // Resolved model_config name
  modelConfigId: 'uuid',                 // model_configs.id
  providerKey: 'copilot',                // Provider identifier
  providerModel: 'gpt-4o',              // Upstream model name
  providerConfigId: 'uuid',             // provider_configs.id
  mode: 'deep',                         // Model mode
  inputPrice: 0,                        // Per 1M input tokens
  outputPrice: 0,                       // Per 1M output tokens
  pricingType: 'token',                 // 'token' | 'request'
  requestCost: 0,                       // Flat cost for request-priced models
  isFree: true,                         // Free model flag
  maxConcurrency: 3,                    // Max concurrent requests
  tierName: 'fast-tier',                // Tier name (if resolved via tier)
  tierId: 'uuid',                       // Tier ID (if resolved via tier)
}
```

### OpenRouter Pricing Fallback

When a model has no pricing in the database (`inputPrice === 0 && outputPrice === 0`) and is not request-priced, `buildModelInfo()` calls `lookupOpenRouterPricing(providerModel)` to fetch pricing data from OpenRouter's model directory. This ensures cost tracking works even for models with incomplete DB configuration.

### Cooldown System

The cooldown system (`model-cooldown.mjs`) is an in-memory Map keyed by `modelConfigName`:

```javascript
{
  expiresAt: timestamp,
  errorType: 'rate_limit_error',
  message: 'Rate limit exceeded',
  cooledAt: ISO string,
}
```

**Cooldown triggers** (`shouldTriggerCooldown()`): errors classified as `payment_required` or `rate_limit_error` (configurable via `config.cooldownTriggers`).

**Cooldown duration**: `config.cooldownDurationMs` (default 1 hour / 3,600,000ms).

**Cascade rules** (`shouldCascade()`): any error with an `errorClassification` type triggers cascade to the next model in the tier. This covers both cooldown scenarios (where the model is also placed in cooldown) and immediate cascade scenarios (where the model simply failed but isn't cooled down).

**Cleanup**: expired entries are auto-removed on access (`isModelInCooldown()`) and by a periodic cleanup interval every 5 minutes.

**Management**: `getCooldownStatus()` returns all active cooldowns for the dashboard. `clearCooldown()` and `clearAllCooldowns()` allow manual override.

### Concurrency Semaphore

`model-queue.mjs` implements per-model concurrency control:

```javascript
acquireModelSlot(resolvedModel, maxConcurrency)
```

1. Maintain an in-memory semaphore per model: `{ active, maxConcurrency, waiters[] }`
2. If `active < maxConcurrency`, increment and return a release function immediately
3. Otherwise, add to the waiters queue with a 60-second timeout
4. On timeout, throw `QueueTimeoutError` (503 with `Retry-After: 10`)
5. On release, hand the slot directly to the next waiter (no gap)

`getQueueStats()` exposes active/max/waiting counts per model for the metrics endpoint.

### Model Retry Loop

The pipeline's outer retry loop (in `pipeline.mjs`) handles model-level failures:

```
for modelAttempt = 0..maxModelRetries (5):
  resolve model
  acquire concurrency slot
  try:
    dispatch with per-provider retries
    stream or buffer response
    break on success
  catch:
    if cooldown trigger -> put in cooldown, continue
    if cascade trigger  -> continue (no cooldown)
    else                -> throw (non-recoverable)
  finally:
    release slot
```

The `attemptedModels` set prevents re-resolving to a model that already failed in this request.

## Implementation

| File | Role |
|------|------|
| `pipeline/model-router.mjs` | `resolveModel()`, `resolveFromTier()`, `buildModelInfo()` |
| `pipeline/model-cooldown.mjs` | Cooldown state: put, check, clear, should-trigger, should-cascade |
| `pipeline/model-queue.mjs` | Per-model concurrency semaphore with queue and timeout |
| `pipeline/openrouter-pricing.mjs` | OpenRouter pricing fallback lookup |
| `db/models-dao.mjs` | `getModelByName()`, `getTierByName()` DB queries |

## Dependencies

- DS001 (Request Pipeline) -- pipeline drives the model retry loop
- DS006 (Database Schema) -- model_configs table with type, model_refs, fallback_model
- DS009 (Error Handling) -- error classification determines cooldown vs cascade vs throw
