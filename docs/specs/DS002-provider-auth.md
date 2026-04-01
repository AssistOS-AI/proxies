# DS002 -- Provider Authentication

## Summary

This specification describes the OAuth credential management system that allows Soul Gateway to authenticate directly with upstream LLM providers using managed OAuth flows, multi-account credential pooling, and automatic token refresh. It covers the three authentication types (API key, managed OAuth, internal), the adapter interface, credential storage, format converters, and auto-provisioning.

## Problem

Soul Gateway needs to support both static API key authentication (where the key is stored encrypted in the database) and managed OAuth authentication (where tokens are obtained via user-driven flows and refreshed automatically). Managed auth enables access to providers like GitHub Copilot, AWS Kiro, OpenAI Codex, Google Gemini, and Anthropic Claude.ai without requiring users to obtain API keys manually.

Multiple accounts per provider are needed for quota management -- when one account is exhausted, the system rotates to the next available account.

## Design

### Three Auth Types

Each entry in `provider_configs` has an `auth_type` field that determines how the gateway authenticates with the upstream provider:

| Auth Type | Mechanism | Examples |
|-----------|-----------|----------|
| `api_key` | Static API key stored encrypted in the `encrypted_api_key` column of `provider_configs`. Decrypted at dispatch time and sent as a Bearer token. Key is encrypted at rest using AES-256. No token refresh or rotation logic needed. | OpenAI, Anthropic (direct), Google, OpenRouter, Groq, Fireworks, DeepSeek |
| `managed` | OAuth credentials stored on disk in the credential store (`/shared/soul-gateway/providers/`). Tokens are refreshed automatically. The `encrypted_api_key` column is NULL. Supports multi-account pooling and quota rotation. | Copilot, Kiro, Codex, Gemini, Anthropic (OAuth) |
| `internal` | Used for internal services that run alongside Soul Gateway (e.g., Search Gateway). No external authentication needed beyond what the service itself handles. No credentials needed. | Search Gateway |

### Provider Properties

| Property | Description |
|----------|-------------|
| `name` | Unique identifier for the provider (e.g., `"openai"`, `"anthropic-oauth"`, `"copilot"`) |
| `display_name` | Human-readable name shown in the dashboard |
| `protocol` | Wire protocol: `openai`, `anthropic`, or `google`. Determines how requests are formatted. |
| `base_url` | Upstream API endpoint (e.g., `https://api.openai.com/v1`) |
| `billing_type` | Authentication category: `api_key`, `managed`, or `internal` |
| `auth_type` | Specific auth mechanism within the billing type (e.g., `"device_flow"`, `"pkce"`) |

### Architecture

```
auth-manager.mjs          -- Registry, credential access, refresh loop, rotation
credential-store.mjs       -- File-based per-provider/per-account storage
device-flow.mjs            -- Generic RFC 8628 device flow
pkce-flow.mjs              -- Generic PKCE OAuth flow
adapters/
  copilot.mjs              -- GitHub device flow + Copilot token exchange
  kiro.mjs                 -- AWS Cognito PKCE
  codex.mjs                -- OpenAI PKCE
  gemini.mjs               -- Google device flow
  anthropic.mjs            -- Claude.ai PKCE
format-converters/
  anthropic-messages.mjs   -- OpenAI <-> Anthropic Messages API
  copilot-responses.mjs    -- OpenAI <-> Copilot Responses API
  kiro-eventstream.mjs     -- OpenAI <-> AWS binary event stream
  search.mjs               -- OpenAI <-> Search results
```

### Auth Manager

The `auth-manager.mjs` module is the central coordinator for managed-auth providers. It maintains a registry of adapter modules and orchestrates credential retrieval, token refresh, account rotation, and auto-provisioning.

**Key Functions:**

| Function | Description |
|----------|-------------|
| `registerAdapter(adapter)` | Registers an OAuth adapter (called during startup for each provider) |
| `getCredentials(providerName)` | Returns `{ token, headers, formatConverter }` for the active account, refreshing if needed |
| `startAuth(providerName)` | Initiates an OAuth flow (device flow or PKCE) |
| `pollAuth(providerName)` | Polls device flow for completion |
| `handlePKCECallback(providerName, code, state)` | Handles OAuth redirect callback |
| `rotateAccount(providerName)` | Marks current account as quota-exhausted and switches to next |
| `reconcileProviders()` | Startup reconciliation: ensures DB rows exist for all credential-bearing providers |

### Adapter Interface

Each provider adapter exports a default object with the following contract:

```javascript
export default {
  name: 'copilot',                    // Unique provider identifier
  authType: 'device-flow',            // 'device-flow' | 'pkce'
  callbackPort: null,                 // Port for PKCE redirect, null for device flow
  refreshMarginMs: 60000,             // Refresh token this many ms before expiry

  config: { /* provider-specific OAuth config */ },

  async startAuth(),                  // Initiate auth flow
  async pollForToken(deviceCode, interval), // Device flow: poll for completion
  async exchangeCode(code, state),    // PKCE: exchange auth code for tokens
  async refreshToken(account),        // Refresh expiring token
  async getHeaders(account),          // Get auth headers for upstream requests

  formatConverter: null,              // Optional format converter module
  providerTemplate: { /* DB row template for auto-provisioning */ },
  knownModels: [],                    // Model IDs to auto-provision
}
```

### Adapter Details

| Adapter | Auth Flow | Format Converter | Notes |
|---------|-----------|-----------------|-------|
| **Copilot** | Device Flow (GitHub) | `copilot-responses` | Authenticates via `github.com/login/device`. Gets a Copilot token from GitHub API. Token auto-refreshes. Subscription-billed. |
| **Kiro** | Cognito + PKCE | `kiro-eventstream` | AWS Cognito-based auth with PKCE code challenge. Uses a local callback server for the redirect. |
| **Codex** | PKCE (ChatGPT) | `copilot-responses` | Authenticates against `chatgpt.com` OAuth. Uses `chatgpt.com/backend-api/codex/responses` endpoint. |
| **Gemini** | Device Flow (Google) | None (native OpenAI-compatible) | Google OAuth device flow. Limited device flow endpoint. |
| **Anthropic** | PKCE | `anthropic-messages` | Anthropic OAuth for free-tier models (Haiku). Paid models require separate routing. |
| **Search** | Internal | `search` | Not OAuth -- adapter for the Search Gateway internal service. |

### Credential Storage

Credentials are stored on the filesystem, not in the database, to keep OAuth tokens separate from the relational data model. The default base directory is `/shared/soul-gateway/providers/` (overridable via `CREDENTIAL_STORE_PATH` env var).

```
/shared/soul-gateway/providers/{provider}/
  accounts/
    account-0.json     -- { accessToken, refreshToken, expiresAt, email, quotaExhausted, quotaResetAt }
    account-1.json
  state.json           -- { activeIndex: 0, lastRotation: "..." }
```

**Credential Store Operations:**

| Function | Description |
|----------|-------------|
| `readAccounts(provider)` | Lists all `account-N.json` files sorted by index |
| `writeAccount(provider, index, data)` | Writes/updates an account file |
| `removeAccount(provider, index)` | Deletes an account file |
| `readState(provider)` | Reads `state.json` (defaults to `{ activeIndex: 0 }`) |
| `writeState(provider, state)` | Updates `state.json` |
| `nextAccountIndex(provider)` | Returns max existing index + 1 |

### Credential Access Flow

When `getCredentials(providerName)` is called during upstream dispatch:

1. Read the state file to find `activeIndex`
2. Read accounts and find the active account
3. If active account is quota-exhausted, find the next non-exhausted account
4. If token is expiring within `refreshMarginMs`, trigger a refresh
5. Return `{ token, headers, formatConverter }`

```javascript
// From auth-manager.mjs -- credential retrieval with auto-refresh
export async function getCredentials(providerName) {
  const adapter = adapters.get(providerName);
  if (!adapter) return null;

  const accounts = await store.readAccounts(providerName);
  if (accounts.length === 0) return null;

  // Find active, non-exhausted account
  let account = accounts.find(a => a._index === state.activeIndex);
  if (!account || account.quotaExhausted) {
    account = accounts.find(a => !a.quotaExhausted);
    if (!account) return null; // All exhausted
  }

  // Refresh if expiring soon
  if (account.expiresAt && Date.now() + refreshMarginMs > account.expiresAt) {
    await refreshAccountToken(providerName, account._index, adapter, account);
  }

  return {
    token: account.accessToken,
    headers: adapter.getHeaders ? await adapter.getHeaders(account) : {},
    formatConverter: adapter.formatConverter || null,
  };
}
```

### Multi-Account Credential Pooling

Each provider supports multiple accounts (e.g., multiple GitHub accounts for Copilot). The credential store tracks them as `account-0.json`, `account-1.json`, etc. The `state.json` file records which account index is currently active.

**Account Rotation:**

When a request fails with a quota error (HTTP 402 or quota-specific rate limit) and the provider uses managed auth:

1. Mark current account as `quotaExhausted: true`
2. Set `quotaResetAt` to next midnight UTC
3. Find next non-exhausted account and update `activeIndex`
4. If all accounts exhausted, return HTTP 429 `quota_exhausted`

The retry logic in `retry.mjs` detects quota errors for managed providers and calls `rotateAccount()` before retrying the dispatch:

```javascript
if (err.dbConfig?.auth_type === 'managed' &&
    (err.errorClassification?.type === 'payment_required' || err.status === 402)) {
  const rotated = await authManager.rotateAccount(err.dbConfig.name);
  if (rotated) continue; // retry with new account
  throw ... // all accounts exhausted
}
```

### Token Refresh Loop

A background interval (default 60s) runs in `auth-manager.mjs` via `startRefreshLoop()`:

1. For each registered adapter, read all accounts
2. **Quota reset:** If an account's `quotaResetAt` has passed, clear the `quotaExhausted` flag
3. **Token refresh:** If `expiresAt` is within the adapter's `refreshMarginMs` (default 60s) and the account doesn't need re-auth, call `adapter.refreshToken(account)`
4. On refresh failure, mark account as `needsReauth`

Concurrent refresh coalescing prevents multiple simultaneous refresh calls for the same account -- a `refreshInProgress` Map of in-progress refresh Promises is used to deduplicate.

### Auto-Provisioning

After the first successful OAuth login for a provider, `autoProvision()`:

1. **Provider creation:** Checks if a `provider_configs` DB row exists for the provider name. If not, creates one from the adapter's `providerTemplate` (which includes display_name, protocol, base_url, billing_type, auth_type).
2. **Model creation:** If the adapter has a `knownModels` array, creates a `model_configs` row for each model ID using `upsertModel()`. Model names follow the `axl/<provider>/<model>` convention via `buildModelName()`.

This bridges the gap between file-based credential storage and DB-driven model routing. `reconcileProviders()` runs at startup to ensure all providers with existing credentials have DB rows. Both steps are idempotent -- safe to call on every login and every startup.

```
  OAuth Login Complete
        |
  autoProvision(providerName, adapter)
        |
  +-----+-------------------------------------------+
  |                                                   |
  1. getProviderByName(name)                          |
     - exists? skip                                   |
     - missing? createProvider(template)              |
  |                                                   |
  2. for each knownModel:                             |
       upsertModel({                                  |
         name: buildModelName(provider, model),       |
         provider_key: provider,                      |
         provider_model: model,                       |
       })                                             |
  +---------------------------------------------------+
```

### Format Converters

Not all upstream providers speak OpenAI's chat completion format natively. Format converters translate between the gateway's OpenAI-compatible interface and provider-specific protocols. They are selected automatically based on the provider's auth adapter. When the `auth-manager` returns credentials for a managed provider, it also returns the adapter's `formatConverter` property.

All format converters yield the same typed chunk interface used throughout the pipeline:

| Chunk Type | Fields | Description |
|------------|--------|-------------|
| `text_delta` | `{ type, text }` | Incremental text content from the LLM |
| `tool_calls_delta` | `{ type, toolCalls }` | Incremental tool/function call data |
| `done` | `{ type, fullText, toolCalls, usage, stopReason }` | Final chunk with complete response, token usage, and stop reason |
| `error` | `{ type, error }` | Error from the upstream provider |

**The Four Converters:**

#### 1. `anthropic-messages`

Converts between OpenAI Chat Completions and the Anthropic Messages API.

| Aspect | OpenAI Format | Anthropic Format |
|--------|--------------|------------------|
| System messages | `messages` array with `role: "system"` | Top-level `system` field as array of content blocks |
| Tool calls (request) | `tool_calls` array with `function.name` / `function.arguments` | `tool_use` content blocks with `name` / `input` |
| Tool results | `role: "tool"` with `tool_call_id` | `role: "user"` with `tool_result` content block |
| Tool choice | `"auto"`, `"none"`, `"required"` | `{ type: "auto" }`, `{ type: "none" }`, `{ type: "any" }` |
| Stop sequences | `stop` (string or array) | `stop_sequences` (array) |
| SSE format | `data:` lines with `[DONE]` sentinel | Named events: `message_start`, `content_block_delta`, `message_delta` |
| Stop reason | `"stop"`, `"tool_calls"` | `"end_turn"`, `"tool_use"` (mapped back to OpenAI names) |

The converter also injects a Claude Agent SDK marker in the system content blocks, which is required by Anthropic to allow OAuth tokens to access paid models.

#### 2. `copilot-responses`

Converts between OpenAI Chat Completions and the GitHub Copilot API, which supports two endpoints:

| Endpoint | Format | Used For |
|----------|--------|----------|
| `/chat/completions` | Standard OpenAI SSE | Most models (GPT-4o, GPT-4.1, Claude Sonnet, etc.) |
| `/responses` | Responses API with named events | Codex models (`gpt-5.3-codex`, `gpt-5.4`, etc.) |

The converter uses **smart endpoint routing**: it caches which endpoint each model needs and tries the cached preference first. If the model returns `unsupported_api_for_model`, it automatically falls back to the other endpoint and caches the result for future requests. Models with "codex" in the name default to the Responses API.

For the Responses API, the converter transforms:
- System messages into the `instructions` field
- Message roles: `system` becomes `developer`, others pass through
- `max_tokens` becomes `max_output_tokens`
- Tool definitions: nested `function` object is flattened to top level
- Named SSE events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`) are mapped to typed chunks

A separate `createResponsesOnlyConverter()` factory is available for providers that exclusively use the Responses API (e.g., OpenAI Codex at `chatgpt.com/backend-api/codex`).

#### 3. `kiro-eventstream`

Converts between OpenAI Chat Completions and Kiro's proprietary AWS binary event stream format.

| Aspect | OpenAI Format | Kiro Format |
|--------|--------------|-------------|
| Request structure | `messages` array | `conversationState` with `currentMessage` + `history` pairs |
| System messages | `role: "system"` | Prepended to first user message content |
| Tool definitions | `tools[].function.parameters` | `toolSpecification.inputSchema.json` |
| Tool results | `role: "tool"` messages | `toolResults` array on `userInputMessageContext` |
| Response format | SSE text stream | AWS binary event stream (4-byte length prefix, typed headers, JSON payload) |
| Model names | As-is | Normalized: `claude-sonnet-4-5` becomes `claude-sonnet-4.5` |

This converter uses `node:https` instead of `fetch()` because the binary event stream protocol requires raw `Buffer` access for parsing the wire format (4-byte total length, 4-byte headers length, prelude CRC, headers, payload, message CRC). The response parser supports header types including bool, byte, short, int, long, bytes, string, timestamp, and UUID.

**Note:** Kiro does not return token usage information. The `done` chunk always has `usage: null`.

#### 4. `search`

Converts between OpenAI Chat Completions and the internal web search aggregator. This is not an external API but an internal provider that queries web search engines.

| Model Name | Search Provider | Requires API Key |
|------------|----------------|-----------------|
| `tavily-search` | Tavily | Yes (`TAVILY_API_KEY`) |
| `brave-search` | Brave Search | Yes (`BRAVE_API_KEY`) |
| `exa-search` | Exa | Yes (`EXA_API_KEY`) |
| `serper-search` | Serper | Yes (`SERPER_API_KEY`) |
| `gemini-search` | Gemini Grounding | Yes (`GEMINI_API_KEY`) |
| `duckduckgo-search` | DuckDuckGo | No |
| `searxng-search` | SearXNG | No |
| `jina-search` | Jina | No (optional `JINA_API_KEY`) |
| `deep-research` | All enabled providers | At least one |

The search converter extracts the query from the last user message (supports both plain text and JSON `{"query": "..."}` format), calls the appropriate search provider, and returns results formatted as Markdown. The `deep-research` model queries all enabled providers in parallel, deduplicates results by URL, and aggregates them. API keys can come from environment variables or from the `search_gateway.search_providers` database table.

### Auth Flow Endpoints

The dashboard API exposes endpoints for managing auth flows:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/providers/:id/auth/status` | Auth status and account list |
| POST | `/api/v1/providers/:id/auth/start` | Start device or PKCE flow |
| GET | `/api/v1/providers/:id/auth/poll` | Poll device flow completion |
| DELETE | `/api/v1/providers/:id/auth/accounts/:idx` | Remove account |
| POST | `/api/v1/providers/:id/auth/reset-quota` | Reset quota exhaustion flags |
| GET | `/api/v1/providers/:id/auth/callback` | PKCE redirect callback |

### Auth Status States

The `getAuthStatus()` function returns one of:

| Status | Meaning |
|--------|---------|
| `no_accounts` | No OAuth accounts have been registered for this provider |
| `active` | At least one account is authenticated and has quota |
| `expiring` | The active token is about to expire (within refresh margin) |
| `all_exhausted` | Every account has hit its quota limit. Resets at midnight UTC. |
| `needs_reauth` | Token refresh failed; the account needs a new OAuth flow |

Example response:

```json
{
  "status": "active",
  "activeIndex": 0,
  "accounts": [
    { "index": 0, "email": "user@example.com", "expiresAt": "...", "quotaExhausted": false, "needsReauth": false },
    { "index": 1, "email": "user2@example.com", "quotaExhausted": true, "quotaResetAt": "2026-04-01T00:00:00Z" }
  ]
}
```

## Implementation

| File | Role |
|------|------|
| `providers/auth-manager.mjs` | Central registry, credential access, refresh loop, rotation, auto-provisioning |
| `providers/credential-store.mjs` | File-based credential read/write per provider/account |
| `providers/device-flow.mjs` | Generic RFC 8628 device flow implementation |
| `providers/pkce-flow.mjs` | Generic PKCE OAuth flow implementation |
| `providers/adapters/*.mjs` | Provider-specific OAuth adapters |
| `providers/format-converters/anthropic-messages.mjs` | OpenAI <-> Anthropic Messages API format converter |
| `providers/format-converters/copilot-responses.mjs` | OpenAI <-> Copilot Responses API format converter |
| `providers/format-converters/kiro-eventstream.mjs` | OpenAI <-> AWS binary event stream format converter |
| `providers/format-converters/search.mjs` | OpenAI <-> Search results format converter |
| `pipeline/retry.mjs` | Quota-driven account rotation during retries |
| `pipeline/upstream-dispatch.mjs` | Credential injection before upstream calls |

## Dependencies

- DS001 (Request Pipeline) -- credential injection during dispatch
- DS004 (Model Routing) -- auto-provisioned models must be routable
- DS009 (Error Handling) -- quota error detection triggers rotation
- DS011 (Unified Provider Auth) -- detailed per-provider adapter specifications
