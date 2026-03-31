# DS001 -- Request Pipeline

## Summary

This specification describes the full lifecycle of a `/v1/chat/completions` request through Soul Gateway, from HTTP ingress to final response. The pipeline orchestrates authentication, body parsing, model routing, middleware execution, upstream dispatch with retry, response streaming, cost calculation, log recording, and real-time broadcasting.

## Problem

Soul Gateway must process LLM requests reliably across multiple providers with varying APIs, error behaviors, and latency profiles. The pipeline must handle both streaming and non-streaming responses, enforce rate limits and budgets, run extensible middleware hooks, and produce comprehensive audit logs -- all without adding significant latency overhead.

## Design

### Entry Point

The HTTP server (`server.mjs`) routes POST requests on `/v1/chat/completions` and `/chat/completions` to the `pipeline()` function. The function is async and handles its own error responses (the server's catch block is a fallback for truly unexpected errors).

### Pipeline Steps

The pipeline executes the following steps in order:

**Step 1: Authentication**

```javascript
authCtx = await authenticate(req);
```

Extract the `Authorization: Bearer <key>` header, look up the key by SHA-256 hash in `api_keys`, and verify it is not revoked or expired. Returns `{ api_key_id, rpm_limit, tpm_limit, key_daily_budget, soul_id }`. Throws `AuthError` (401) on failure.

**Step 2: Agent and Session Identification**

Extract agent name from `X-Soul-Agent` header, falling back to user-agent parsing. Extract optional session ID from `X-Soul-Session` header.

**Step 3: Body Parsing**

Read and parse the JSON request body. Validate required fields: `model` and `messages`. Extract `stream` flag and all additional LLM parameters (tools, tool_choice, temperature, etc.) via destructuring.

**Step 4: Model Resolution**

```javascript
modelInfo = await resolveModel(body.model);
```

Resolve the requested model name to a concrete provider/model pair. See DS004 for the full resolution algorithm. Returns `modelInfo` with `resolvedModel`, `providerKey`, `providerModel`, `inputPrice`, `outputPrice`, `maxConcurrency`, `tierId`, etc.

**Step 5: Pre-Dispatch Middlewares**

Run all enabled pre-middlewares assigned to the resolved tier and/or model config. Middlewares can mutate `messages` and `params`, or abort the request. On abort with status 200 and an `abortResponse` (cache hit), return the cached response directly. On abort with an error status, return the error. See DS003 for middleware execution semantics.

**Step 6: Prompt Hash and Size Check**

Compute SHA-256 of `messages + resolvedModel` for cache deduplication. Estimate prompt token count (`chars / 4`) and flag if it exceeds 50,000 tokens.

**Step 7: Dispatch with Model Cooldown Fallback**

Enter a retry loop (up to `maxModelRetries = 5` iterations):

1. Acquire a concurrency slot for the resolved model (semaphore with queue timeout)
2. Call `dispatchWithRetry()` which handles per-provider retries (up to `maxRetries = 3`)
3. On success, consume the response via `tapStream()` (streaming) or `handleNonStreaming()` (buffered)
4. On cooldown-triggering error (`rate_limit_error`, `payment_required`): put model in cooldown, re-resolve, try next model
5. On immediate-cascade error (any classified upstream error): skip to next model without cooldown
6. Release concurrency slot in `finally` block

**Step 8: Cost Calculation**

```javascript
const costs = calculateCost(result.usage, modelInfo.inputPrice, modelInfo.outputPrice, modelInfo.pricingType, modelInfo.requestCost);
```

See DS007 for the cost formula.

**Step 9: Post-Dispatch Middlewares**

Run all enabled post-middlewares with the response content, usage data, and cost metadata on the context. See DS003.

**Step 10: Response Checks**

Flag `is_truncated` if `stop_reason` is `max_tokens` or `length`. Flag `is_slow` if latency exceeds 30,000ms.

**Step 11: Log Recording**

Insert the complete log entry into `call_logs` via `safeInsertLog()` (catches DB errors to prevent impacting the response).

**Step 12: Real-Time Broadcast**

Broadcast the log entry to WebSocket subscribers (`broadcastLog`) and soul-specific subscribers (`broadcastToSoul`).

### Error Handling

All errors within the pipeline are caught by a try/catch block:

- **`SoulGatewayError`** instances: return the error's status code, type, and message in OpenAI error format. Include `Retry-After` header when present.
- **Unexpected errors**: return 500 with `internal_error` type. Log the full stack trace.

In both cases, a log entry is written to `call_logs` with the error details.

### Request ID

Each request is assigned a unique ID in the format `chatcmpl-<UUID>`. This ID appears in all SSE chunks and the final response.

## Implementation

| File | Role |
|------|------|
| `pipeline/pipeline.mjs` | Main pipeline function, orchestrates all steps |
| `pipeline/auth.mjs` | API key authentication |
| `pipeline/model-router.mjs` | Model resolution (DS004) |
| `pipeline/middleware-runner.mjs` | Pre/post middleware execution (DS003) |
| `pipeline/retry.mjs` | Upstream dispatch with retry (DS009) |
| `pipeline/stream-tap.mjs` | SSE streaming and non-streaming response handling (DS005) |
| `pipeline/cost-calculator.mjs` | Cost calculation (DS007) |
| `pipeline/prompt-checker.mjs` | Prompt size estimation |
| `pipeline/response-checker.mjs` | Truncation and slow-request flagging |
| `pipeline/model-cooldown.mjs` | Cooldown state management |
| `pipeline/model-queue.mjs` | Per-model concurrency semaphore |
| `db/logs-dao.mjs` | Log insertion |
| `ws/log-stream.mjs` | WebSocket log broadcasting |
| `ws/soul-stream.mjs` | Soul-specific broadcasting |

## Dependencies

- DS003 (Middleware Framework) -- pre/post middleware execution
- DS004 (Model Routing) -- model resolution and tier fallback
- DS005 (Streaming) -- response streaming
- DS007 (Rate Limiting & Budgets) -- cost calculation
- DS009 (Error Handling) -- retry logic and error classification
