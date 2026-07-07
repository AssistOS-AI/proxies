# SearchAgent Architecture

## Role

SearchAgent is a Ploinky MCP-first agent for normalized web search. It hides provider-specific response shapes and returns search results with stable `title`, `url`, and `snippet` fields while preserving useful provider-specific fields.

GPTResearcher uses SearchAgent for web search through router-mediated agent-to-agent MCP calls. SearchAgent no longer exposes a custom HTTP service or classic `/services/search-agent/*` endpoints.

## Runtime

The agent uses the bundled Ploinky AgentServer. `manifest.json` declares MCP readiness and does not define `start`, `agent`, TCP readiness, `httpServices`, or provider API keys.

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
- `SEARXNG_URL`

`duckduckgo` requires no secret. `jina` can work without `JINA_API_KEY`, but uses it when configured.

## Providers

Providers are registered by the MCP tool entrypoints in `tools/search.mjs` and `tools/list-providers.mjs`:

- `duckduckgo`
- `tavily`
- `brave`
- `exa`
- `serper`
- `searxng`
- `jina`

Provider listing returns each provider and the configured state for required secrets. A provider can be listed while unconfigured; a search through an unconfigured provider returns `PROVIDER_NOT_CONFIGURED`.

## Search Flow

For `search_agent_search`, `tools/search.mjs`:

1. Reads non-secret settings.
2. Validates `provider` and `query`.
3. Applies `maxQueryChars` and `maxResults`.
4. Loads only the DPU secrets required by the selected provider.
5. Calls the provider implementation.
6. Returns normalized results.

SearchAgent does not semantically rewrite queries. Individual providers may apply provider-specific constraints, such as Tavily's query length limit.

## Errors

Tool failures return JSON with `ok: false`, an `error` object, and `results: []` for search-shaped failures. Provider HTTP failures use `PROVIDER_HTTP_ERROR` and include a short provider response preview when available.
