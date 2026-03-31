# DS005 -- Streaming

## Summary

This specification describes how Soul Gateway handles SSE streaming and non-streaming responses from upstream providers, and how it broadcasts real-time log events over WebSocket and SSE connections.

## Problem

LLM responses can be large and slow. Streaming lets clients begin processing tokens as they arrive, dramatically improving perceived latency. The gateway must pass through SSE chunks from upstream while simultaneously capturing the full response content, token usage, and timing metrics for logging and cost calculation. Additionally, operators need real-time visibility into all gateway activity via WebSocket subscriptions.

## Design

### Stream Tap (SSE Pass-Through)

`tapStream()` in `stream-tap.mjs` consumes an async generator from achillesAgentLib and re-encodes chunks as OpenAI SSE format:

**Response Headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Access-Control-Allow-Origin: *
```

**Chunk Types:**

| Generator Chunk Type | SSE Output | Behavior |
|---------------------|------------|----------|
| `text_delta` | `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` | Accumulates content, records TTFB on first chunk |
| `tool_calls_delta` | `data: {"choices":[{"delta":{"tool_calls":[...]}}]}\n\n` | Passes through tool call fragments |
| `done` | Finish chunk + `data: [DONE]\n\n` | Extracts final content, usage, stop reason |
| `error` | Error chunk + `data: [DONE]\n\n` | Returns partial content with error details |
| `thinking_delta` | (ignored) | Silently skipped |

**TTFB Measurement:** The time-to-first-byte is measured from request start to the first `text_delta` or `tool_calls_delta` chunk.

**Error Handling:** If an error occurs mid-stream (after headers are sent), the error is encoded as an SSE event with `finish_reason: 'error'` and the connection is closed. The partial content accumulated so far is returned for logging.

**Return Value:**

```javascript
{ content, usage, stopReason, ttfbMs, error }
```

### Non-Streaming Handler

`handleNonStreaming()` buffers all chunks from the generator, then returns a complete OpenAI JSON response:

1. Accumulate `text_delta` chunks into `content`
2. Capture `tool_calls` from `done` chunk
3. On `error` chunk: return 502 with `upstream_error`
4. On success: write a complete `chat.completion` JSON response with message (including tool_calls if present), finish_reason, and usage

**Response Format:**

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### WebSocket Log Broadcasting

`ws/log-stream.mjs` manages WebSocket connections on `/ws/v1/logs`:

1. Accept WebSocket upgrade via raw RFC 6455 handshake (`ws/upgrade.mjs`)
2. Maintain a Set of connected sockets
3. On each completed pipeline request, `broadcastLog()` sends the log entry as JSON to all subscribers
4. 15-second ping interval keeps connections alive through Cloudflare tunnel timeouts
5. Node.js request timeout is removed on upgraded sockets (`req.setTimeout(0)`)

### Soul-Specific Broadcasting

`ws/soul-stream.mjs` provides filtered broadcasting where subscribers receive only logs matching their `soul_id`. This allows per-client real-time dashboards.

### SSE Alternative

For clients that cannot use WebSocket (e.g., behind restrictive proxies), an SSE endpoint provides the same log stream via standard `text/event-stream` responses.

## Implementation

| File | Role |
|------|------|
| `pipeline/stream-tap.mjs` | `tapStream()` SSE pass-through, `handleNonStreaming()` buffered response |
| `ws/upgrade.mjs` | WebSocket handshake and upgrade handling |
| `ws/log-stream.mjs` | WebSocket log broadcasting to all subscribers |
| `ws/soul-stream.mjs` | Soul-filtered WebSocket broadcasting |
| `server.mjs` | Routes upgrade events and SSE endpoints |

## Dependencies

- DS001 (Request Pipeline) -- pipeline calls tapStream/handleNonStreaming and broadcastLog
- DS006 (Database Schema) -- log entries are broadcast after DB insertion
