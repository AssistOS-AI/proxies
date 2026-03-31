# User Requirements Specification (URS)

## Document Information

| Field | Value |
|-------|-------|
| System | Soul Gateway |
| Version | 1.0 |
| Date | 2026-03-31 |

## Purpose

This document defines the high-level user requirements for Soul Gateway, an LLM proxy that provides unified access to multiple AI providers through a single OpenAI-compatible API endpoint.

## Scope

Soul Gateway sits between client applications (agents, coding assistants, web UIs) and upstream LLM providers (OpenAI, Anthropic, Google, GitHub Copilot, AWS Kiro, OpenRouter, and others). It handles authentication, routing, rate limiting, cost tracking, content safety, and real-time observability.

## Requirements

| ID | Requirement | Description | Design Spec |
|----|-------------|-------------|-------------|
| URS01 | Multi-Provider LLM Access | The system shall route LLM requests to multiple upstream providers including OpenAI, Anthropic, Google, GitHub Copilot, AWS Kiro, OpenRouter, and any provider exposing an OpenAI-compatible API. Clients shall not need to manage individual provider credentials. | DS001, DS004, DS011 |
| URS02 | OpenAI API Compatibility | The system shall expose an OpenAI-compatible `/v1/chat/completions` endpoint accepting standard request format (model, messages, stream, tools, tool_choice, and all standard parameters). Clients using any OpenAI SDK shall work without modification. The system shall also proxy Anthropic Messages API (`/v1/messages`) and OpenAI Responses API (`/v1/responses`) requests natively. | DS001, DS005 |
| URS03 | Per-Key Rate Limiting | The system shall enforce per-API-key rate limits for both requests per minute (RPM) and tokens per minute (TPM). Default limits shall be 60 RPM and 100,000 TPM. Limits shall be configurable per key. When exceeded, the system shall return HTTP 429 with a Retry-After header. | DS007 |
| URS04 | Cost Control | The system shall track per-request costs based on token usage and model pricing. It shall enforce daily and monthly budget limits per API key. When a budget is exceeded the system shall reject further requests until the budget period resets. Cost data shall be available in real time through the dashboard and API. | DS007 |
| URS05 | Real-Time Observability | The system shall provide real-time visibility into all LLM calls: request/response content, token counts, costs, latency, errors, and agent identification. Live log streaming shall be available over WebSocket and SSE connections. A system metrics endpoint shall expose queue depths, cooldown states, and uptime. | DS005, DS006 |
| URS06 | Authentication | The system shall authenticate client requests using Bearer token API keys. Keys shall be stored encrypted (AES-256) in the database with only key hashes used for lookup. For upstream providers, the system shall support both static API keys and managed OAuth credentials (device flow and PKCE), with multi-account pooling and automatic token refresh. | DS002, DS011 |
| URS07 | Middleware Extensibility | The system shall support a pluggable middleware framework that can intercept requests before dispatch (pre-middlewares) and after response (post-middlewares). Middlewares shall be discovered automatically from the filesystem without requiring a restart. Each middleware shall be independently configurable per model or tier. | DS003 |
| URS08 | Content Safety | The system shall provide content filtering through configurable blacklist rules supporting exact match, substring match, and regex patterns. When a request matches a blacklist rule, it shall be blocked with an appropriate error. The system shall also detect agent loops (repetitive request patterns) and intervene or block as configured. | DS008, DS010 |
| URS09 | Model Tiering | The system shall support grouping models into priority-ordered tiers. When a client requests a tier name, the system shall resolve it to the first available model in priority order, skipping models that are in cooldown or disabled. Cooldowns shall be triggered by transient provider errors (rate limits, payment errors) and expire after a configurable duration (default 1 hour). | DS004 |
| URS10 | Operations Dashboard | The system shall provide a web-based dashboard for managing API keys, providers, models, tiers, blacklist rules, and middlewares. The dashboard shall display live call logs, cost summaries, error rates, and cooldown status. Access shall be protected by a configurable password. | DS001, DS006 |
| URS11 | Graceful Provider Failure | The system shall handle upstream provider failures gracefully. On transient errors (timeouts, rate limits, 5xx), it shall retry with exponential backoff. On persistent model-level failures, it shall cascade to alternate models within the same tier. The system shall never crash or hang due to a provider outage. | DS009, DS004 |
| URS12 | Streaming Support | The system shall support both streaming (SSE) and non-streaming response modes. Streaming responses shall pass through chunks in real time with minimal added latency. The system shall capture full response content and token usage metrics from streams for logging and cost calculation. | DS005 |
