# Unified Provider Auth System — Design Spec

## Problem

Soul Gateway currently relies on 3 external gateways (CLIProxyAPI, Copilot Gateway, Kiro Gateway) for provider authentication. This creates a fragile chain:

```
Client → Soul Gateway → CLIProxyAPI → OpenAI/Anthropic/Google
Client → Soul Gateway → Copilot Gateway → GitHub Copilot
Client → Soul Gateway → Kiro Gateway → AWS Kiro
```

Each hop adds latency, failure points, and operational complexity. The external gateways handle OAuth device flows, token management, and format conversion that Soul Gateway should handle natively.

## Solution

Integrate all 5 provider authentication flows and 2 format converters directly into Soul Gateway, with multi-account credential pooling for quota-driven rotation.

```
Client → Soul Gateway → OpenAI/Anthropic/Google/Copilot/Kiro (direct)
```

## Provider Auth Architecture

### File Structure

```
app/src/providers/
├── auth-manager.mjs          # Registry, token refresh loop, credential rotation
├── credential-store.mjs      # File-based credential storage per provider/account
├── device-flow.mjs           # Generic RFC 8628 device flow (polling-based)
├── pkce-flow.mjs             # Generic PKCE OAuth flow (callback-based)
├── adapters/
│   ├── copilot.mjs           # GitHub device flow → Copilot token exchange
│   ├── kiro.mjs              # AWS Cognito + PKCE
│   ├── codex.mjs             # OpenAI OAuth + PKCE
│   ├── gemini.mjs            # Google OAuth device flow
│   └── anthropic.mjs         # Claude.ai OAuth
└── format-converters/
    ├── copilot-responses.mjs  # OpenAI ↔ Copilot Responses API
    └── kiro-eventstream.mjs   # OpenAI ↔ AWS event-stream binary
```

### Provider Adapter Interface

Each adapter exports:

```javascript
export default {
  name: 'copilot',
  authType: 'device-flow',        // 'device-flow' | 'pkce'
  callbackPort: null,             // port number for PKCE callback, null for device flow

  // Provider-specific OAuth config
  config: {
    clientId: '...',
    deviceCodeUrl: '...',
    tokenUrl: '...',
    scopes: '...',
  },

  async startAuth()               // Returns { userCode, verificationUri } or { authUrl }
  async pollForToken()            // For device flow: poll until user completes
  async exchangeCode(code, verifier) // For PKCE: exchange auth code for tokens
  async refreshToken(creds)       // Refresh before expiry
  async getHeaders(creds)         // Returns auth headers for upstream requests

  formatConverter: null,          // or import from format-converters/

  credentialsDir: '/shared/soul-gateway/providers/copilot/'
}
```

### Multi-Account Credential Pooling

Each provider stores multiple accounts on disk:

```
/shared/soul-gateway/providers/copilot/
├── accounts/
│   ├── account-0.json    # { accessToken, refreshToken, expiresAt, email, quotaExhausted, quotaResetAt }
│   ├── account-1.json
│   └── account-2.json
└── state.json            # { activeIndex: 0, lastRotation: "..." }
```

**Rotation logic** (in `auth-manager.mjs`):
1. Request uses `activeIndex` account
2. On quota error (402, or rate_limit with quota-specific message):
   - Mark current account `quotaExhausted: true`, set `quotaResetAt` (next day midnight UTC)
   - Increment `activeIndex` to next non-exhausted account
   - Retry the request with new credentials
3. If all accounts exhausted → return 429 to client with "all provider accounts quota exhausted"
4. Background loop: reset `quotaExhausted` when `quotaResetAt` has passed

### Token Refresh

`auth-manager.mjs` runs a background refresh loop (every 60s):
- For each provider with managed auth, check all accounts
- If token expires within provider's refresh margin (Copilot: 60s, Kiro: 10min, Codex: 5min), refresh it
- On refresh failure: log warning, mark account for re-auth
- Concurrent refresh coalescing: if multiple requests trigger refresh simultaneously, share one refresh call

## Database Changes

Single column addition to `provider_configs`:

```sql
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS auth_type TEXT DEFAULT 'api_key';
-- 'api_key': static key stored encrypted in DB (current behavior)
-- 'managed': OAuth credentials managed on disk by auth-manager
```

No new tables. Model routing, middleware system, and all existing features unchanged.

## Pipeline Integration

### upstream-dispatch.mjs

Before calling `fetchLLMStreaming`, check provider auth type:

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

### Quota-driven retry

In `retry.mjs` or `pipeline.mjs`, when a dispatch fails with quota error and provider is managed:

```javascript
if (isQuotaError(err) && dbConfig.auth_type === 'managed') {
  const rotated = await authManager.rotateAccount(dbConfig.name);
  if (rotated) {
    // Retry with new account credentials
    continue;
  }
}
```

## The 5 Provider Adapters

### Copilot

| Aspect | Detail |
|--------|--------|
| **Auth flow** | Device flow (polling) |
| **Step 1** | POST `github.com/login/device/code` with `client_id=Iv1.b507a08c87ecfe98`, `scope=read:user` |
| **Step 2** | User goes to `github.com/login/device`, enters code |
| **Step 3** | Poll `github.com/login/oauth/access_token` until authorized |
| **Step 4** | Exchange GitHub token for Copilot token at `api.github.com/copilot_internal/v2/token` |
| **Refresh** | Copilot token ~30min, auto-refresh using GitHub token |
| **Format converter** | Yes — smart routing between completions and Responses API endpoints |
| **Headers** | VS Code spoofing (editor version, machine ID) |
| **Callback port** | None (polling-based) |

### Kiro

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `prod.us-east-1.auth.desktop.kiro.dev/login?idp=Google&code_challenge=...` |
| **Step 2** | User signs in with Google |
| **Step 3** | Redirect to `localhost:3128/oauth/callback?code=...` |
| **Step 4** | Exchange code + verifier for tokens at `.../oauth/token` |
| **Refresh** | POST `prod.us-east-1.auth.desktop.kiro.dev/refreshToken`, 10min margin |
| **Format converter** | Yes — OpenAI messages → `conversationState` format, AWS binary event stream parsing |
| **Headers** | `User-Agent: KiroIDE-0.7.45-{fingerprint}`, `X-Amzn-CodeWhisperer-Optout: true` |
| **Callback port** | 3128 |

### Codex/OpenAI

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=...` |
| **Step 2** | User signs in with OpenAI account |
| **Step 3** | Redirect to `localhost:1455/oauth/callback?code=...` |
| **Step 4** | Exchange code + verifier at `auth.openai.com/oauth/token` |
| **Refresh** | Auto-refresh when expiring within 5min |
| **Format converter** | None (standard OpenAI format) |
| **Headers** | Standard `Authorization: Bearer {token}` |
| **Callback port** | 1455 |

### Gemini/Google

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

### Anthropic/Claude

| Aspect | Detail |
|--------|--------|
| **Auth flow** | PKCE (browser redirect) |
| **Step 1** | Open browser to `claude.ai/oauth/authorize?...` |
| **Step 2** | User signs in with Anthropic account |
| **Step 3** | Redirect to `localhost:54545/oauth/callback?code=...` |
| **Step 4** | Exchange for `sk-ant-oat01-...` token (~1 year validity) |
| **Refresh** | Minimal — token valid ~1 year |
| **Format converter** | None (Anthropic API already supported via anthropic-proxy.mjs) |
| **Headers** | `Authorization: Bearer sk-ant-oat01-...` |
| **Callback port** | 54545 |

## Format Converters

### Copilot Responses API Converter

Copilot has two endpoints — some models only work with the Responses API, not the standard completions API:

- **Request conversion**: OpenAI chat messages → Responses API `input` array with `message` items
- **Tool conversion**: OpenAI `tools` → Responses API `tools` with `type: "function"`
- **Response conversion**: Responses API event stream → OpenAI SSE chunks
- **Smart routing**: Try completions first, cache endpoint per model, fall back to Responses if `unsupported_api_for_model`

### Kiro Event Stream Converter

Kiro uses AWS's custom binary event stream protocol:

- **Request conversion**: OpenAI messages → `conversationState` with `assistantResponseMessage` + `userInputMessage` pairs, system messages prepended to first user message, tool calls → `toolUses` array
- **Binary parsing**: 12-byte prelude (total length + headers length), variable-length headers (key-value pairs), payload, 4-byte CRC32
- **Response extraction**: Parse `assistantResponseEvent` and `codeEvent` payloads, reconstruct as OpenAI SSE chunks
- **Tool handling**: `toolUse` events → `tool_calls` in response

## Dashboard API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/providers/:id/auth/status` | Auth status + account list |
| POST | `/api/v1/providers/:id/auth/start` | Start device flow or PKCE flow |
| GET | `/api/v1/providers/:id/auth/poll` | Poll device flow completion |
| DELETE | `/api/v1/providers/:id/auth/accounts/:idx` | Remove an account |
| POST | `/api/v1/providers/:id/auth/reset-quota` | Reset quota exhaustion flags |
| GET | `/api/v1/providers/:id/auth/callback` | OAuth callback for PKCE flows |

## Dashboard UI

Providers page gets auth status section for managed providers:
- Status badge: green (active) / yellow (expiring) / red (needs auth)
- Account list: email, token expiry, quota status per account
- "Add Account" button: triggers device flow or PKCE flow
- "Remove Account" button
- "Reset Quota" button: clears exhaustion flags

## What Stays the Same

- Pipeline middleware system — untouched
- Model routing / tier resolution — untouched
- Cost calculation, logging, broadcasting — untouched
- Existing `api_key` providers — continue working as before
- All 12 middlewares — untouched
- Cache middleware — untouched

## Implementation Order

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
