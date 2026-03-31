# DS002 -- Provider Authentication

## Summary

This specification describes the OAuth credential management system that allows Soul Gateway to authenticate directly with upstream LLM providers using managed OAuth flows, multi-account credential pooling, and automatic token refresh.

## Problem

Soul Gateway needs to support both static API key authentication (where the key is stored encrypted in the database) and managed OAuth authentication (where tokens are obtained via user-driven flows and refreshed automatically). Managed auth enables access to providers like GitHub Copilot, AWS Kiro, OpenAI Codex, Google Gemini, and Anthropic Claude.ai without requiring users to obtain API keys manually.

Multiple accounts per provider are needed for quota management -- when one account is exhausted, the system rotates to the next available account.

## Design

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
  copilot-responses.mjs    -- OpenAI <-> Copilot Responses API
  kiro-eventstream.mjs     -- OpenAI <-> AWS binary event stream
```

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

### Credential Storage

Credentials are stored on the filesystem, not in the database, to keep OAuth tokens separate from the relational data model:

```
/shared/soul-gateway/providers/{provider}/
  accounts/
    account-0.json     -- { accessToken, refreshToken, expiresAt, email, quotaExhausted, quotaResetAt }
    account-1.json
  state.json           -- { activeIndex: 0, lastRotation: "..." }
```

### Credential Access Flow

When `getCredentials(providerName)` is called during upstream dispatch:

1. Read the state file to find `activeIndex`
2. Read accounts and find the active account
3. If active account is quota-exhausted, find the next non-exhausted account
4. If token is expiring within `refreshMarginMs`, trigger a refresh
5. Return `{ token, headers, formatConverter }`

### Multi-Account Rotation

When a request fails with a quota error (HTTP 402 or quota-specific rate limit) and the provider uses managed auth:

1. Mark current account as `quotaExhausted: true`
2. Set `quotaResetAt` to next midnight UTC
3. Find next non-exhausted account and update `activeIndex`
4. If all accounts exhausted, return HTTP 429 `quota_exhausted`

The retry logic in `retry.mjs` detects quota errors for managed providers and calls `rotateAccount()` before retrying the dispatch.

### Token Refresh Loop

A background interval (default 60s) runs in `auth-manager.mjs`:

1. For each registered adapter, read all accounts
2. Reset `quotaExhausted` for accounts whose `quotaResetAt` has passed
3. Refresh tokens expiring within the adapter's `refreshMarginMs`
4. On refresh failure, mark account as `needsReauth`

Concurrent refresh coalescing prevents multiple simultaneous refresh calls for the same account -- a Map of in-progress refresh Promises is used to deduplicate.

### Auto-Provisioning

After the first successful OAuth login for a provider, `autoProvision()`:

1. Creates a `provider_configs` DB row from the adapter's `providerTemplate` (if not already existing)
2. Creates `model_configs` rows for each model ID in `adapter.knownModels`

This bridges the gap between file-based credential storage and DB-driven model routing. `reconcileProviders()` runs at startup to ensure all providers with existing credentials have DB rows.

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
- `no_accounts` -- no credentials stored
- `active` -- at least one non-exhausted, non-expired account
- `expiring` -- active account token expiring within refresh margin
- `all_exhausted` -- all accounts quota-exhausted
- `needs_reauth` -- account tokens invalid, re-auth required

## Implementation

| File | Role |
|------|------|
| `providers/auth-manager.mjs` | Central registry, credential access, refresh loop, rotation, auto-provisioning |
| `providers/credential-store.mjs` | File-based credential read/write per provider/account |
| `providers/device-flow.mjs` | Generic RFC 8628 device flow implementation |
| `providers/pkce-flow.mjs` | Generic PKCE OAuth flow implementation |
| `providers/adapters/*.mjs` | Provider-specific OAuth adapters |
| `providers/format-converters/*.mjs` | Request/response format converters |
| `pipeline/retry.mjs` | Quota-driven account rotation during retries |
| `pipeline/upstream-dispatch.mjs` | Credential injection before upstream calls |

## Dependencies

- DS001 (Request Pipeline) -- credential injection during dispatch
- DS004 (Model Routing) -- auto-provisioned models must be routable
- DS009 (Error Handling) -- quota error detection triggers rotation
- DS011 (Unified Provider Auth) -- detailed per-provider adapter specifications
