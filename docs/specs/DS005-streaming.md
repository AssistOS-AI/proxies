# DS005 -- Streaming

## Summary

This specification describes how Soul Gateway handles SSE streaming and non-streaming responses from upstream providers, and how it broadcasts real-time log events over WebSocket and SSE connections. It covers the raw RFC 6455 WebSocket implementation, the heartbeat system, and the broadcast architecture.

## Problem

LLM responses can be large and slow. Streaming lets clients begin processing tokens as they arrive, dramatically improving perceived latency. The gateway must pass through SSE chunks from upstream while simultaneously capturing the full response content, token usage, and timing metrics for logging and cost calculation. Additionally, operators need real-time visibility into all gateway activity via WebSocket subscriptions.

## Design

### Architecture Overview

```
  Upstream Provider
    |  (async generator: text_delta, tool_calls_delta, done, error chunks)
    v
  stream-tap.mjs
    |  Re-encodes as OpenAI SSE format
    |  Captures: content, usage, stopReason, ttfbMs
    v
  Client (SSE)
    |
    |  Meanwhile, after request completes:
    v
  broadcastLog()          broadcastToSoul()
    |                       |
    v                       v
  /ws/v1/logs            /ws/v1/soul/:id
  (all subscribers)      (soul-specific)
    |                       |
    v                       v
  WebSocket clients      WebSocket clients
  SSE clients
```

### Stream Tap (SSE Pass-Through)

When a client sets `stream: true`, the `tapStream()` function in `stream-tap.mjs` consumes the async generator from achillesAgentLib and re-encodes each chunk as an OpenAI-compatible Server-Sent Event.

**Response Headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Access-Control-Allow-Origin: *
```

**Chunk Types:**

| Generator Chunk Type | SSE Output | Description |
|---------------------|------------|-------------|
| `text_delta` | `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` | Incremental text content. First chunk triggers TTFB measurement. Content is accumulated internally. |
| `tool_calls_delta` | `data: {"choices":[{"delta":{"tool_calls":[...]}}]}\n\n` | Tool call deltas passed through to client. |
| `done` | `data: {"choices":[{"finish_reason":"stop"}]}` then `data: [DONE]\n\n` | Final chunk with usage stats. The finish chunk may include `usage` data. Followed by the `[DONE]` sentinel. |
| `error` | `data: {"error":{"type":"mid_stream_error",...}}` then `data: [DONE]\n\n` | Mid-stream error from provider. Best-effort delivery (client may have disconnected). The function returns with `error` set. |
| `thinking_delta` | (ignored) | Internal reasoning tokens from some providers. Silently dropped. |

**TTFB Measurement:** The time-to-first-byte is measured from request start to the first `text_delta` or `tool_calls_delta` chunk.

**Error Handling:** If an error occurs mid-stream (after headers are sent), the error is encoded as an SSE event with `finish_reason: 'error'` and the connection is closed. The partial content accumulated so far is returned for logging.

**Return Value:**

Both `tapStream()` and `handleNonStreaming()` return the same shape:

```javascript
{
  content: string,       // Full accumulated text
  usage: {               // Token counts
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
  },
  stopReason: string,    // 'stop', 'length', 'tool_calls', or null on error
  ttfbMs: number | null, // Time to first byte in milliseconds
  error: { type, message } | null
}
```

### Non-Streaming Handler

`handleNonStreaming()` buffers all chunks from the generator, then returns a complete OpenAI JSON response:

1. Accumulate `text_delta` chunks into `content`
2. Capture `tool_calls` from `done` chunk
3. On `error` chunk: return 502 with `upstream_error`
4. On success: write a complete `chat.completion` JSON response with message (including tool_calls if present), finish_reason, and usage

**Response Format:**

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
}
```

### WebSocket Implementation

Soul Gateway implements WebSocket support from scratch using raw TCP sockets, without any external WebSocket library. The implementation follows RFC 6455.

**Upgrade Handshake:**

The `handleUpgrade()` function in `ws/upgrade.mjs` processes the HTTP upgrade request:

1. Validates dashboard authentication (401 if unauthenticated)
2. Extracts the `Sec-WebSocket-Key` header
3. Computes the accept key: `SHA1(key + "258EAFA5-E914-47DA-95CA-5BAB0DC85B11")` base64-encoded
4. Configures the socket: `setTimeout(0)`, `setNoDelay(true)`, `setKeepAlive(true, 30000)`
5. Sends the 101 Switching Protocols response
6. Routes to the appropriate stream handler based on pathname

Node.js request timeout is removed on upgraded sockets (`req.setTimeout(0)`).

**Frame Encoding:**

The `encodeFrame(payload, opcode)` function creates WebSocket frames:

| Payload Size | Header Size | Length Encoding |
|-------------|-------------|-----------------|
| < 126 bytes | 2 bytes | Single byte |
| 126 - 65535 bytes | 4 bytes | 16-bit unsigned (big-endian) |
| > 65535 bytes | 10 bytes | 64-bit unsigned (big-endian) |

All server-to-client frames have the FIN bit set (no fragmentation) and are unmasked. Client-to-server frames are masked per the RFC.

**Frame Decoding:**

The `decodeFrame(buf)` function parses incoming frames, handling the mask bit and variable-length payload headers. Opcodes handled:

| Opcode | Type | Action |
|--------|------|--------|
| `0x01` | Text | Passed to `onMessage` callback |
| `0x02` | Binary | Passed to `onMessage` callback |
| `0x08` | Close | Marks socket dead, calls `onClose`, ends socket |
| `0x09` | Ping | Responds with Pong (`0x0A`) containing same payload |
| `0x0A` | Pong | Ignored (heartbeat acknowledgment) |

**WebSocket Helper (createWsHelper):**

Each upgraded connection gets a `ws` helper object wrapping the raw TCP socket:

```javascript
{
  socket,                // Raw TCP socket
  alive: boolean,        // Connection state flag
  send(data),            // Encode and write a text frame
  close(),               // Send close frame and end socket
  onMessage: callback,   // Set by stream handler
  onClose: callback,     // Set by stream handler
}
```

Incoming data is buffered and decoded in a loop, handling partial frames that span multiple TCP packets.

### Ping/Pong Heartbeat

Every WebSocket connection has a ping interval of **15 seconds**. This is critical for surviving Cloudflare tunnel idle timeouts. The heartbeat:

- Sends an empty Ping frame (`opcode 0x09`) every 15s
- If the send fails, marks the socket as dead and clears the interval
- The interval is also cleared on socket close
- Incoming Ping frames from clients are answered with Pong frames containing the same payload

### WebSocket Routes

**`/ws/v1/logs` -- Global Log Stream:**

Handled by `handleLogStream()` in `ws/log-stream.mjs`. Subscribers receive a sanitized version of every completed pipeline request.

- **Connection:** Adds subscriber to a global `subscribers` Set. Sends `{ type: "connected", filters }`.
- **Filters:** Optional query params `soul_id` and `model` filter which logs are delivered. Filters can be updated at runtime by sending `{ type: "filter", filters: { ... } }`.
- **Disconnection:** Subscriber is removed from the Set. Dead subscribers are also pruned during broadcast.

**`/ws/v1/soul/:id` -- Soul-specific Stream:**

Handled by `handleSoulStream()` in `ws/soul-stream.mjs`. Subscribers receive the full log entry (including response content) for a specific soul ID.

- Subscribers are stored in a `Map<soulId, Set<ws>>`
- When no subscribers remain for a soul, the Map entry is deleted
- Receives the unsanitized log entry (includes `response_content` and `request_messages`)

### SSE Log Streaming

The `handleSseStream()` function in `log-stream.mjs` provides an alternative to WebSockets for environments that don't support them (e.g., some HTTP/1.0 proxies).

**Endpoint:** `GET /api/v1/logs/stream`

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

- Supports the same `soul_id` and `model` query-param filters as WebSocket
- Sends a keepalive comment (`: keepalive`) every 15 seconds to prevent proxy timeouts
- SSE subscribers are tracked in a separate `sseSubscribers` Set
- Dead subscribers are detected when `res.write()` throws and cleaned up

### Broadcast Architecture

After every pipeline request completes (success or failure), two broadcast functions are called:

**`broadcastLog(logEntry)`:**

Sends a sanitized log entry to all matching WebSocket and SSE subscribers. The sanitized version strips `request_messages` and `response_content` to reduce bandwidth, keeping only metadata:

```javascript
{
  id, soul_id, requested_model, resolved_model, mode,
  is_streaming, status_code, stop_reason, error_type,
  error_message, latency_ms, ttfb_ms, prompt_tokens,
  completion_tokens, total_tokens, total_cost,
  retry_count, blocked_by_blacklist, is_truncated,
  is_slow, prompt_size_warning, cache_hit,
  started_at, completed_at
}
```

**`broadcastToSoul(soulId, logEntry)`:**

Sends the full (unsanitized) log entry to subscribers of a specific soul. This includes the complete request messages and response content, enabling real-time monitoring of a specific API key's usage.

**Stream Statistics:**

The `getStreamStats()` function returns the current count of active WebSocket and SSE subscribers, used by the `/metrics` endpoint and dashboard.

## Implementation

| File | Role |
|------|------|
| `pipeline/stream-tap.mjs` | `tapStream()` SSE pass-through, `handleNonStreaming()` buffered response |
| `ws/upgrade.mjs` | WebSocket handshake, frame encoding/decoding, helper creation |
| `ws/log-stream.mjs` | WebSocket and SSE log broadcasting to all subscribers |
| `ws/soul-stream.mjs` | Soul-filtered WebSocket broadcasting |
| `server.mjs` | Routes upgrade events and SSE endpoints |

## Dependencies

- DS001 (Request Pipeline) -- pipeline calls tapStream/handleNonStreaming and broadcastLog
- DS006 (Database Schema) -- log entries are broadcast after DB insertion
