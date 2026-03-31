# DS003 -- Middleware Framework

## Summary

This specification describes the pluggable middleware framework that allows request/response processing to be extended without modifying the core pipeline. Middlewares are discovered from the filesystem, registered in the database, and executed in configurable order per model or tier.

## Problem

Different models, tiers, and use cases need different processing behaviors: caching, budget enforcement, loop detection, prompt augmentation, response filtering, and logging. Hard-coding these into the pipeline would make it rigid and difficult to maintain. A plugin system allows behaviors to be added, removed, and configured independently.

## Design

### Middleware Interface

Each middleware is an `.mjs` file in the `app/src/middlewares/` directory that exports a default object:

```javascript
export default {
  name: 'my-middleware',         // Unique name (used in DB registration)
  description: 'What it does',  // Human-readable description
  type: 'both',                 // 'pre' | 'post' | 'both'
  version: '1.0.0',             // Version string
  supportsStreaming: false,      // Can run after() on streaming responses

  defaultSettings: {             // Default configuration
    enabled: true,
    threshold: 100,
  },

  async before(ctx, settings) { /* pre-dispatch hook */ },
  async after(ctx, settings)  { /* post-dispatch hook */ },
}
```

**Type constraints:**
- `pre`: must have `before()`, `after()` is optional
- `post`: must have `after()`, `before()` is optional
- `both`: must have both `before()` and `after()`

### Context Object

The middleware context (`ctx`) is built by `buildCtx()` in `middleware-runner.mjs`:

```javascript
{
  // Mutable by pre-middlewares
  messages: [],           // Request messages (can be modified)
  params: {},             // LLM parameters (can be modified)

  // Read-only request info
  model: '',              // Resolved model name
  tier: '',               // Tier name (if resolved via tier)
  apiKeyId: '',           // Authenticated API key UUID
  agentName: '',          // Agent name from headers
  sessionId: '',          // Session ID from headers
  isStreaming: false,     // Whether this is a streaming request
  authCtx: {},            // Full auth context (rpm_limit, tpm_limit, etc.)

  // State flowing from before() to after()
  metadata: {},           // Shared state between pre and post hooks

  // Response data (populated in post-dispatch phase)
  response: null,         // Response content string
  isChunk: false,         // Reserved for future chunk-level middleware
  usage: null,            // Token usage object

  // Abort control
  abort: false,           // Set to true to abort the request
  abortStatus: 400,       // HTTP status for abort response
  abortMessage: '',       // Error message for abort
  abortResponse: null,    // Set with abortStatus=200 for success abort (cache hit)
}
```

### Discovery and Registration

`scanMiddlewares()` in `middleware-loader.mjs`:

1. Read all `.mjs` files from the `middlewares/` directory
2. Dynamic import each file with cache-busting (`?t=Date.now()`)
3. Validate the interface: `name` must be a non-empty string, `type` must be valid, required hooks must exist
4. Store the loaded module in an in-memory Map (`loaded`)
5. Upsert a row in the `middlewares` DB table with name, description, file_name, type, supports_streaming, default_settings, and version
6. After scanning, mark DB entries for files no longer on disk as `is_discovered = false`

### Assignment and Configuration

Middlewares are assigned to models or tiers via the `model_middlewares` junction table:

```sql
model_middlewares (
  model_config_id UUID REFERENCES model_configs(id),
  middleware_id UUID REFERENCES middlewares(id),
  is_enabled BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 100,
  settings JSONB DEFAULT '{}'
)
```

The `settings` column holds per-assignment overrides that are merged with the middleware's `defaultSettings`:

```javascript
const settings = { ...defaultSettings, ...overrideSettings };
```

### Execution Order

**Pre-dispatch phase** (in `runPreMiddlewares()`):

1. Load enabled middlewares for the tier (if present) and model config (if present)
2. Concatenate: tier middlewares first, then model middlewares (broad before specific)
3. Filter to middlewares with `type === 'pre'` or `type === 'both'`
4. Execute `before()` in sort-order
5. If any middleware sets `ctx.abort = true`, stop immediately and return `{ aborted: true }`

**Post-dispatch phase** (in `runPostMiddlewares()`):

1. Same loading and concatenation
2. Filter to middlewares with `type === 'post'` or `type === 'both'`
3. For streaming responses: skip middlewares without `supportsStreaming` (chunks already sent)
4. Populate `ctx.response` and `ctx.usage` from the result
5. Execute `after()` in sort-order
6. If a middleware modifies `ctx.response` (non-streaming only), propagate back to result

### Abort Mechanics

**Error abort** (`ctx.abort = true`, `ctx.abortStatus !== 200`):

The pipeline returns the abort status and message as an OpenAI-format error. Optional `ctx.metadata.retryAfter` sets the `Retry-After` header. Optional `ctx.metadata.logFields` are merged into the log entry.

**Success abort** (`ctx.abort = true`, `ctx.abortStatus === 200`, `ctx.abortResponse` set):

The pipeline returns a synthetic `chat.completion` response using the `abortResponse` content. This is used by the cache middleware to return cached responses without hitting the upstream provider. The `abortResponse` may include `content`, `stopReason`, `usage`, `cacheHit`, `promptHash`, and `headers`.

### Error Isolation

Individual middleware errors are caught and logged but do **not** abort the pipeline or affect other middlewares. This ensures a buggy middleware cannot break request processing:

```javascript
try {
  await mw.before(ctx, settings);
} catch (err) {
  log.error(`Middleware ${mw.name} before() error`, { error: err.message });
  // Non-critical: skip and continue
}
```

## Implementation

| File | Role |
|------|------|
| `pipeline/middleware-loader.mjs` | Filesystem discovery, validation, import, DB registration |
| `pipeline/middleware-runner.mjs` | Context building, pre/post execution, settings merging |
| `db/middlewares-dao.mjs` | Middleware and model_middleware CRUD |
| `middlewares/*.mjs` | Individual middleware implementations |

## Dependencies

- DS001 (Request Pipeline) -- pipeline calls runPreMiddlewares/runPostMiddlewares
- DS006 (Database Schema) -- middlewares and model_middlewares tables
- DS007 (Rate Limiting & Budgets) -- budget-tracker middleware
- DS010 (Agent Loop Detector) -- loop-detector middleware
