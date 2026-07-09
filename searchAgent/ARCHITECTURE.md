# SearchAgent Architecture

## Role

SearchAgent is a Ploinky MCP-first agent for normalized web search. It hides provider-specific response shapes and returns search results with stable `title`, `url`, and `snippet` fields while preserving useful provider-specific fields.

GPTResearcher uses SearchAgent for web search through router-mediated agent-to-agent MCP calls. SearchAgent no longer exposes a custom HTTP service or classic `/services/search-agent/*` endpoints.

## Runtime

The agent starts a local SearXNG process for the `searxng` provider, auto-starts a local Google AI Mode browser-pool sidecar when Chromium and `puppeteer-core` are available, and then starts the bundled Ploinky AgentServer. The install hook follows SearXNG's step-by-step installation shape inside the container: clone to `/usr/local/searxng/searxng-src`, install into `/usr/local/searxng/searx-pyenv`, and preinstall the documented build dependencies. SearXNG uses a minimal generated `$HOME/searxng/settings.yml` and otherwise relies on SearXNG defaults. The same install hook installs Chromium and `puppeteer-core` for the optional `google-ai-mode` provider. `manifest.json` declares MCP readiness and does not define TCP readiness, `httpServices`, or provider API keys.

The MCP surface is declared in `mcp-config.json`. Tool handlers live in `tools/` and own the core business logic for search, provider listing, and settings. Shared code in `src/lib/` is limited to cross-tool plumbing such as DPU secret access, tool I/O, errors, and result normalization.

## MCP Tools

SearchAgent exposes authenticated user tools:

- `search_agent_search`: run a search through a selected provider.
- `search_agent_list_providers`: list providers and configured-secret status.
- `search_agent_get_settings`: read non-secret settings.
- `search_agent_update_settings`: persist non-secret settings.

Search input:

```json
{
  "provider": "duckduckgo",
  "query": "search query",
  "maxResults": 5
}
```

Successful search output:

```json
{
  "ok": true,
  "results": []
}
```

## Settings And Secrets

Non-secret settings are still stored in:

```text
$HOME/search-agent-settings.json
```

The file contains only:

```json
{
  "maxResults": 20,
  "maxQueryChars": 4000
}
```

`maxResults` is normalized between `1` and `100`. `maxQueryChars` is normalized between `1` and `20000`.

SearXNG has no user-configurable SearchAgent settings. Runtime startup only needs:

```text
$HOME/searxng/settings.yml
$HOME/searxng/secret_key
```

The generated YAML is intentionally minimal:

```yaml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  secret_key: "<generated>"
```

Everything else comes from SearXNG defaults.

Provider credentials are stored in DPU secrets, not in SearchAgent settings or manifest profiles. SearchAgent reads them by calling `dpuAgent` through `/Agent/client/AgentMcpClient.mjs` and the internal `dpu_agent_secret_get` tool. The SearchAgent settings UI writes secrets with DPU user tools and grants `read` to:

```text
agent:proxies/searchAgent
```

Secret keys are the provider environment names:

- `TAVILY_API_KEY`
- `BRAVE_API_KEY`
- `EXA_API_KEY`
- `SERPER_API_KEY`
- `JINA_API_KEY`
- `GEMINI_API_KEY`

`duckduckgo`, local `searxng`, `deep-research`, and `google-ai-mode` require no provider API secret. `jina` can work without `JINA_API_KEY`, but uses it when configured. `google-ai-mode` is auto-configured by the install/start hooks when Chromium and `puppeteer-core` are present. `BROWSER_EXECUTABLE_PATH`, `BROWSER_POOL_PORT`, `BROWSER_POOL_SIZE`, `BROWSER_HEADLESS_MODE`, `BROWSER_PROXY_URL`, and `BROWSER_USER_DATA_DIR` remain optional runtime overrides.

## Providers

Providers are registered by the MCP tool entrypoints in `tools/search.mjs` and `tools/list-providers.mjs`:

- `duckduckgo`
- `tavily`
- `brave`
- `exa`
- `serper`
- `searxng`
- `jina`
- `gemini`
- `deep-research`
- `google-ai-mode`

Provider listing returns only providers that are ready to use. Local `searxng` is ready after the SearchAgent install hook has installed SearXNG and startup has made its JSON API available on `127.0.0.1:8888`. `google-ai-mode` is ready when the browser-pool sidecar can be started and reached on `127.0.0.1:${BROWSER_POOL_PORT:-8890}`.

`deep-research` is a provider value for `search_agent_search`, not a separate tool. It queries configured API providers from `DEEP_RESEARCH_PROVIDERS` or the default API provider list, skips providers without required secrets, tolerates per-provider failures, deduplicates by URL, and returns normalized results.

## Search Flow

For `search_agent_search`, `tools/search.mjs`:

1. Reads non-secret settings.
2. Validates `provider` and `query`.
3. Applies `maxQueryChars` and `maxResults`.
4. Loads only the DPU secrets required by the selected provider.
5. Calls the provider implementation.
6. Returns normalized results.

SearchAgent does not semantically rewrite queries. Individual providers may apply provider-specific constraints, such as Tavily's query length limit.

## Runtime Logs

SearchAgent writes operational JSON-line logs to `stderr`, so MCP tool payloads on `stdout` stay valid JSON. Logs include metadata such as provider, query length, requested result limit, returned result count, duration, error code, and retryability. They intentionally do not include raw query text, result titles, snippets, URLs, or provider secrets by default.

`deep-research` logs selected providers and providers skipped because they are unknown or missing required secrets. `google-ai-mode` logs browser-pool startup, pool acquisition, search completion, failures, and CAPTCHA/rate-limit detection. Set `SEARCH_AGENT_LOGS=0` to disable these structured logs.

## Errors

Tool failures return JSON with `ok: false`, an `error` object, and `results: []` for search-shaped failures. Provider HTTP failures use `PROVIDER_HTTP_ERROR` and include a short provider response preview when available.
