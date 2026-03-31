# Non-Functional Specification (NFS)

## Document Information

| Field | Value |
|-------|-------|
| System | Soul Gateway |
| Version | 1.0 |
| Date | 2026-03-31 |

## Purpose

This document specifies the non-functional requirements (quality attributes and constraints) for Soul Gateway.

## Requirements

| ID | Requirement | Description | Verification |
|----|-------------|-------------|-------------|
| NFS01 | Technology Stack | The system shall be built with Node.js (v20+) using ES Modules (`.mjs`). It shall use the built-in `node:http` module for HTTP serving with no web framework dependency. PostgreSQL shall be the sole database. The `pg` npm package shall be the database driver. The system shall have no runtime dependency on external web frameworks (Express, Fastify, etc.). | Inspect `package.json` and imports |
| NFS02 | Performance | The system shall add less than 50ms of P95 latency overhead above the upstream provider's response time for non-streaming requests. For streaming requests, the time-to-first-byte (TTFB) overhead shall be less than 200ms above the provider's TTFB. The pipeline shall avoid synchronous blocking operations in the request path. | Load test with latency measurement |
| NFS03 | Reliability | The system shall degrade gracefully when an upstream provider is unavailable. Failed requests shall be retried up to `maxRetries` (default 3) times with exponential backoff (initial 1s, multiplier 2x, max 30s, 20% jitter). Models that repeatedly fail with transient errors shall be placed in cooldown (default 1 hour) and requests shall cascade to alternate models within the tier. The system shall not crash or hang due to any single provider outage. | Fault injection testing |
| NFS04 | Security | API keys shall be stored using AES-256 encryption with only SHA-256 hashes used for lookup (no plaintext key storage). Provider API keys in `provider_configs` shall be stored encrypted. The dashboard shall be protected by password authentication using HTTP-only cookies. CORS headers (`Access-Control-Allow-Origin: *`) shall be set on all API responses. The spec viewer shall validate document parameters to prevent path traversal attacks. | Security audit |
| NFS05 | Scalability | The system shall support per-model concurrency limits via in-memory semaphores (default 3 concurrent requests per model). Requests exceeding concurrency shall queue with a 60-second timeout (`QueueTimeoutError`). Rate limiting shall use a 60-second sliding window implemented in PostgreSQL (survives restarts). The system shall handle at least 60 concurrent API keys each at their default RPM limit. | Concurrent load test |
| NFS06 | Portability | The system shall be deployable via Ploinky manifest as either a container (`node:20-slim` image) or a bubblewrap (bwrap) sandbox. The manifest shall declare all environment variables with defaults. The system shall not depend on host-specific paths or services beyond PostgreSQL. | Deploy in both modes |
| NFS07 | Observability | The system shall emit structured log output via `createLogger()` with component tags (server, pipeline, retry, middleware, etc.). A `/metrics` endpoint shall expose system metrics (queue depths, cooldown states, uptime) without authentication. A `/health` endpoint shall return `{ status: "ok", uptime: <seconds> }` for load balancer health checks. All LLM calls shall be recorded in `call_logs` with full request/response content. | Inspect log output and endpoints |
| NFS08 | Data Retention | Call logs shall be stored in monthly-partitioned PostgreSQL tables (`call_logs_YYYY_MM`). The system shall automatically create new partitions and drop partitions older than the configured retention period (default 90 days). Partitioning shall be by `started_at` timestamp. Indexes shall be partition-local for query performance. | Verify partition creation and expiry |
| NFS09 | Availability | The system shall support graceful shutdown: on SIGTERM, stop accepting new connections and drain in-flight requests. The `/health` endpoint shall respond within 100ms. WebSocket connections shall use 15-second ping intervals to survive Cloudflare tunnel idle timeouts. The server shall remove Node.js request timeouts on upgraded WebSocket connections. | Shutdown test, health check timing |
| NFS10 | Extensibility | New middlewares shall be deployable by adding an `.mjs` file to the `middlewares/` directory. The middleware loader shall scan the directory, validate the interface (`name`, `type`, `before()`/`after()`), and register in the database via upsert. Middlewares removed from disk shall be marked as undiscovered. No code changes or restarts shall be required to add or remove a middleware (cache-busted dynamic imports). | Add middleware file, verify discovery |
| NFS11 | Error Transparency | All errors returned to clients shall follow the OpenAI error format: `{ error: { type: string, message: string } }`. HTTP status codes shall be semantically correct: 400 for bad requests, 401 for auth failures, 404 for unknown models, 429 for rate limits/budgets/loops, 502 for upstream errors, 503 for queue timeouts, 500 for internal errors. Rate-limit and budget errors shall include `Retry-After` headers. | Verify error responses |
| NFS12 | Zero-Framework HTTP | The HTTP server shall be built on `node:http.createServer()` with manual URL parsing, CORS handling, and JSON serialization. WebSocket upgrade shall be handled via the `upgrade` event with raw RFC 6455 frame encoding. This eliminates framework dependencies and keeps the binary minimal. | Inspect server.mjs |
