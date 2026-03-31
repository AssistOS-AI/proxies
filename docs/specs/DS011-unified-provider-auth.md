# DS011 -- Unified Provider Auth

## Summary

This specification describes the integration of all 5 provider authentication flows (Copilot, Kiro, Codex, Gemini, Anthropic) and 2 format converters directly into Soul Gateway, eliminating the dependency on external gateway services (CLIProxyAPI, Copilot Gateway, Kiro Gateway).

## Problem

Soul Gateway currently relies on 3 external gateways for provider authentication:

```
Client -> Soul Gateway -> CLIProxyAPI -> OpenAI/Anthropic/Google
Client -> Soul Gateway -> Copilot Gateway -> GitHub Copilot
Client -> Soul Gateway -> Kiro Gateway -> AWS Kiro
```

Each hop adds latency, failure points, and operational complexity. The external gateways handle OAuth device flows, token management, and format conversion that Soul Gateway should handle natively.

## Design

### Target Architecture

```
Client -> Soul Gateway -> OpenAI/Anthropic/Google/Copilot/Kiro (direct)
```

### File Structure

```
app/src/providers/
  auth-manager.mjs          -- Registry, token refresh loop, credential rotation
  credential-store.mjs      -- File-based credential storage per provider/account
  device-flow.mjs           -- Generic RFC 8628 device flow (polling-based)
  pkce-flow.mjs             -- Generic PKCE OAuth flow (callback-based)
  adapters/
    copilot.mjs             -- GitHub device flow -> Copilot token exchange
    kiro.mjs                -- AWS Cognito + PKCE
    codex.mjs               -- OpenAI OAuth + PKCE
    gemini.mjs              -- Google OAuth device flow
    anthropic.mjs           -- Claude.ai OAuth
  format-converters/
    copilot-responses.mjs   -- OpenAI <-> Copilot Responses API
    kiro-eventstream.mjs    -- OpenAI <-> AWS event-stream binary
```

### Provider Adapter Interface

Each adapter exports a default object following the contract defined in DS002. The key additional details for each provider are specified below.

### The 5 Provider Adapters

#### Copilot (GitHub)

| Aspect | Detail |
|--------|--------|
| **Auth flow** | Device flow (polling) |
| **Step 1** | POST `github.com/login/device/code` with `client_id=Iv1.b507a08c87ecfe98`, `scope=read:user` |
| **Step 2** | User goes to `github.com/login/device`, enters code |
| **Step 3** | Poll `github.com/login/oauth/access_token` until authorized |
| **Step 4** | Exchange GitHub token for Copilot token at `api.github.com/copilot_internal/v2/token` |
| **Refresh** | Copilot token valid ~30 minutes, auto-refresh using stored GitHub token |
| **Format converter** | Yes -- smart routing between completions and Responses API endpoints |
| **Headers** | VS Code spoofing: editor version, machine ID, session ID |
| **Callback port** | None (polling-based) |

#### Kiro (AWS)

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `prod.us-east-1.auth.desktop.kiro.dev/login?idp=Google&code_challenge=...` |
| **Step 2** | User signs in with Google |
| **Step 3** | Redirect to `localhost:3128/oauth/callback?code=...` |
| **Step 4** | Exchange code + verifier for tokens at `.../oauth/token` |
| **Refresh** | POST `prod.us-east-1.auth.desktop.kiro.dev/refreshToken`, 10-minute margin |
| **Format converter** | Yes -- OpenAI messages to `conversationState` format, AWS binary event stream parsing |
| **Headers** | `User-Agent: KiroIDE-0.7.45-{fingerprint}`, `X-Amzn-CodeWhisperer-Optout: true` |
| **Callback port** | 3128 |

#### Codex (OpenAI)

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=...` |
| **Step 2** | User signs in with OpenAI account |
| **Step 3** | Redirect to `localhost:1455/oauth/callback?code=...` |
| **Step 4** | Exchange code + verifier at `auth.openai.com/oauth/token` |
| **Refresh** | Auto-refresh when expiring within 5 minutes |
| **Format converter** | None (standard OpenAI format) |
| **Headers** | Standard `Authorization: Bearer {token}` |
| **Callback port** | 1455 |

#### Gemini (Google)

| Aspect | Detail |
|--------|--------|
| **Auth flow** | Device flow (polling) |
| **Step 1** | POST `oauth2.googleapis.com/device/code` with client_id + scopes |
| **Step 2** | User goes to `google.com/device`, enters code |
| **Step 3** | Poll `oauth2.googleapis.com/token` until authorized |
| **Refresh** | Standard Google refresh token flow at `oauth2.googleapis.com/token` |
| **Format converter** | None (OpenAI-compatible endpoint) |
| **Headers** | Standard `Authorization: Bearer {token}` |
| **Callback port** | None (polling-based) |

#### Anthropic (Claude.ai)

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `claude.ai/oauth/authorize?...` |
| **Step 2** | User signs in with Anthropic account |
| **Step 3** | Redirect to `localhost:54545/oauth/callback?code=...` |
| **Step 4** | Exchange for `sk-ant-oat01-...` token (approximately 1 year validity) |
| **Refresh** | Minimal -- token valid approximately 1 year |
| **Format converter** | None (Anthropic API already supported via `anthropic-proxy.mjs`) |
| **Headers** | `Authorization: Bearer sk-ant-oat01-...` |
| **Callback port** | 54545 |

### Format Converters

#### Copilot Responses API Converter

Copilot has two endpoints -- some models only work with the Responses API, not the standard completions API:

- **Request conversion**: OpenAI chat messages to Responses API `input` array with `message` items
- **Tool conversion**: OpenAI `tools` to Responses API `tools` with `type: "function"`
- **Response conversion**: Responses API event stream to OpenAI SSE chunks
- **Smart routing**: Try completions endpoint first, cache the working endpoint per model, fall back to Responses API if `unsupported_api_for_model` error is returned

#### Kiro Event Stream Converter

Kiro uses AWS's custom binary event stream protocol:

- **Request conversion**: OpenAI messages to `conversationState` with `assistantResponseMessage` + `userInputMessage` pairs. System messages are prepended to the first user message. Tool calls are converted to `toolUses` array.
- **Binary parsing**: 12-byte prelude (total length + headers length), variable-length headers (key-value pairs), payload, 4-byte CRC32 checksum
- **Response extraction**: Parse `assistantResponseEvent` and `codeEvent` payloads, reconstruct as OpenAI SSE chunks
- **Tool handling**: `toolUse` events are converted to `tool_calls` in the response

### Multi-Account Credential Pooling

Each provider stores multiple accounts on disk:

```
/shared/soul-gateway/providers/{provider}/
  accounts/
    account-0.json    -- { accessToken, refreshToken, expiresAt, email, quotaExhausted, quotaResetAt }
    account-1.json
    account-2.json
  state.json          -- { activeIndex: 0, lastRotation: "..." }
```

**Rotation logic** (in `auth-manager.mjs`):

1. Request uses the `activeIndex` account
2. On quota error (402, or rate limit with quota-specific message):
   - Mark current account `quotaExhausted: true`, set `quotaResetAt` to next day midnight UTC
   - Increment `activeIndex` to next non-exhausted account
   - Retry the request with new credentials
3. If all accounts exhausted: return 429 to client with "all provider accounts quota exhausted"
4. Background loop: reset `quotaExhausted` when `quotaResetAt` has passed

### Token Refresh

`auth-manager.mjs` runs a background refresh loop every 60 seconds:

- For each provider with managed auth, check all accounts
- If token expires within the provider's refresh margin (Copilot: 60s, Kiro: 10min, Codex: 5min), refresh it
- On refresh failure: log warning, mark account for re-auth
- Concurrent refresh coalescing: if multiple requests trigger refresh simultaneously, share one refresh call via a Promise Map

### Database Changes

Single column addition to `provider_configs`:

```sql
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS auth_type TEXT DEFAULT 'api_key';
```

Values:
- `api_key`: static key stored encrypted in DB (existing behavior)
- `managed`: OAuth credentials managed on disk by auth-manager

No new tables. Model routing, middleware system, and all existing features remain unchanged.

### Pipeline Integration

In `upstream-dispatch.mjs`, before calling the upstream LLM:

```javascript
let apiKey, extraHeaders, formatConverter;

if (dbConfig.auth_type === 'managed') {
  const creds = await authManager.getCredentials(dbConfig.name);
  apiKey = creds.token;
  extraHeaders = creds.headers;
  formatConverter = authManager.getFormatConverter(dbConfig.name);
} else {
  apiKey = dbConfig.api_key || await getProviderApiKey(dbConfig.id);
}

if (formatConverter) {
  return formatConverter.dispatch(messages, payload, apiKey, extraHeaders, signal);
} else {
  return fetchLLMStreaming(baseURL, apiKey, payload, signal, extraHeaders);
}
```

### Dashboard API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/providers/:id/auth/status` | Auth status + account list |
| POST | `/api/v1/providers/:id/auth/start` | Start device flow or PKCE flow |
| GET | `/api/v1/providers/:id/auth/poll` | Poll device flow completion |
| DELETE | `/api/v1/providers/:id/auth/accounts/:idx` | Remove an account |
| POST | `/api/v1/providers/:id/auth/reset-quota` | Reset quota exhaustion flags |
| GET | `/api/v1/providers/:id/auth/callback` | OAuth callback for PKCE flows |

### Auto-Provisioning

After each successful OAuth login, `autoProvision()` runs:

1. Check if a `provider_configs` row exists for this provider name
2. If not, create one from `adapter.providerTemplate` with display_name, protocol, base_url, billing_type, auth_type
3. Create `model_configs` rows for each model in `adapter.knownModels` using the `axl/{provider}/{model}` naming convention

`reconcileProviders()` runs at startup to ensure all providers with stored credentials have corresponding DB rows.

### What Stays the Same

- Pipeline middleware system -- untouched
- Model routing / tier resolution -- untouched
- Cost calculation, logging, broadcasting -- untouched
- Existing `api_key` providers -- continue working as before
- All middlewares -- untouched
- Cache middleware -- untouched

### Implementation Order

1. Generic auth infrastructure (auth-manager, credential-store, device-flow, pkce-flow)
2. Copilot adapter + format converter (easiest, well-understood)
3. Kiro adapter + format converter (hardest, binary protocol)
4. Codex adapter (PKCE, no format conversion)
5. Gemini adapter (device flow, no format conversion)
6. Anthropic adapter (PKCE, no format conversion)
7. Pipeline integration (upstream-dispatch credential routing)
8. Multi-account pooling + quota rotation
9. Dashboard auth UI
10. Remove external gateway dependencies from deploy scripts

## Implementation

| File | Role |
|------|------|
| `providers/auth-manager.mjs` | Central registry, credential access, refresh loop, rotation |
| `providers/credential-store.mjs` | File-based per-provider/per-account storage |
| `providers/device-flow.mjs` | Generic RFC 8628 device flow |
| `providers/pkce-flow.mjs` | Generic PKCE OAuth flow |
| `providers/adapters/copilot.mjs` | GitHub device flow + Copilot token exchange |
| `providers/adapters/kiro.mjs` | AWS Cognito PKCE adapter |
| `providers/adapters/codex.mjs` | OpenAI PKCE adapter |
| `providers/adapters/gemini.mjs` | Google device flow adapter |
| `providers/adapters/anthropic.mjs` | Claude.ai PKCE adapter |
| `providers/format-converters/copilot-responses.mjs` | Copilot Responses API converter |
| `providers/format-converters/kiro-eventstream.mjs` | AWS binary event stream converter |
| `pipeline/upstream-dispatch.mjs` | Credential injection and format converter routing |
| `pipeline/retry.mjs` | Quota-driven account rotation |

## Dependencies

- DS001 (Request Pipeline) -- credential injection during upstream dispatch
- DS002 (Provider Auth) -- builds on the auth-manager infrastructure
- DS004 (Model Routing) -- auto-provisioned models must be routable
- DS009 (Error Handling) -- quota error detection triggers rotation
