# DS010 -- Agent Loop Detector

## Summary

This specification describes the behavioral loop detection system that identifies agents stuck in repetitive request patterns and intervenes to break the cycle. It is implemented as a `both`-type middleware with configurable detection thresholds and response modes.

## Problem

The original loop detector checked for rapid-fire requests (>50/min) and consecutive identical message arrays. Neither catches real agent loops because:

- Agents in loops typically make 2-5 calls/min (well under the rapid-fire threshold)
- Each call adds tool results to the conversation, making the full messages array unique every time
- The actual loop signature is: **assistant responses repeat while the conversation grows**

## Design

### Detection Signals

#### Signal 1: Response Similarity (post-dispatch)

After each response, extract a **fingerprint**: sorted tool names called + first 200 characters of response content, hashed with SHA-256. Store the last `similarityWindow` (default 7) fingerprints per tracking ID.

If `similarityThreshold` (default 5) or more of the last `similarityWindow` fingerprints are identical, flag as loop.

**Why this works:** An agent stuck calling `read_file` on the same path, or retrying the same failed command, produces identical fingerprints. Normal productive work produces diverse fingerprints across calls.

#### Signal 2: Conversation Growth Rate (pre-dispatch)

Track `messages.length` and estimated token count per request. If a session has accumulated >50K tokens of growth AND response fingerprints show >60% repetition rate, flag as loop.

**Why this works:** Normal agent work grows the conversation with diverse responses. A loop grows the conversation with repetitive responses. The combination of "growing fast" + "not making progress" is the distinguishing signal.

### Tracking

**Tracking ID:** `sessionId` when the `X-Soul-Session` header is present. Falls back to `apiKeyId:agentName` composite key when not.

**State per tracking ID:**

| Field | Type | Description |
|-------|------|-------------|
| `fingerprints` | Array | Last `similarityWindow` response hashes |
| `requestCount` | Number | Total requests in this tracking session |
| `tokenGrowth` | Number | Cumulative estimated tokens across requests |
| `lastAccess` | Timestamp | For eviction |
| `loopDetected` | Boolean | Sticky -- once detected, stays true for the session |
| `interventionCount` | Number | How many times the system has intervened |

**Eviction:** Entries older than 30 minutes are cleaned every 5 minutes.

### Actions

The response mode is configurable via the `mode` setting:

#### `mode: 'intervene'` (default)

Do not abort the request. Instead, prepend a system message to `ctx.messages`:

> *[Soul Gateway] Loop detected: your last several responses followed the same pattern. Stop the current approach and try something different.*

The LLM sees this warning and can break the cycle. The message text is configurable via the `interventionMessage` setting.

#### `mode: 'block'`

Abort the request with HTTP 429:

```javascript
ctx.abort = true;
ctx.abortStatus = 429;
ctx.abortMessage = 'Loop detected -- request blocked';
```

The agent receives a `LoopDetectedError` and must handle it externally.

#### `mode: 'log'`

Log the detection but take no action. This mode is used for monitoring and threshold tuning before enabling enforcement.

### Middleware Interface

Type: `both` (needs `before()` for growth tracking and intervention injection, `after()` for response fingerprinting)

**Default Settings:**

```javascript
{
  enabled: true,
  mode: 'intervene',
  similarityThreshold: 5,
  similarityWindow: 7,
  growthTokenThreshold: 50000,
  interventionMessage: '[Soul Gateway] Loop detected: your last several responses followed the same pattern. Stop and try a different approach.',
}
```

### before() Hook

1. Resolve tracking ID from `ctx.sessionId` or `ctx.apiKeyId:ctx.agentName`
2. Read or create tracking state
3. Update `requestCount` and `tokenGrowth` with current message token estimate
4. Check if loop was previously detected (`loopDetected` flag)
5. Check growth signal: tokenGrowth > threshold AND repetition rate > 60%
6. If loop detected:
   - Mode `intervene`: prepend intervention message to `ctx.messages`, increment `interventionCount`
   - Mode `block`: set `ctx.abort = true`, `ctx.abortStatus = 429`
   - Mode `log`: record to metadata only
7. Store log fields in `ctx.metadata.logFields` for the pipeline to record

### after() Hook

1. Extract response fingerprint: sort tool names (if present) + first 200 chars of `ctx.response`, hash with SHA-256
2. Push fingerprint to the tracking state's `fingerprints` array (capped at `similarityWindow`)
3. Check similarity: count identical fingerprints in the window
4. If count >= `similarityThreshold`, set `loopDetected = true`
5. Update `lastAccess` timestamp

### What Was Removed

From the original loop detector:

- Rapid-fire detection (handled by the rate-limiter middleware)
- Identical message array detection (replaced by response fingerprinting)
- `checkLoopDetection()` export (replaced by middleware interface)
- `getLoopDetectorStats()` export (replaced or updated)

## Implementation

| File | Role |
|------|------|
| `pipeline/loop-detector.mjs` | Detection engine: fingerprinting, growth tracking, state management |
| `middlewares/loop-detector.mjs` | Middleware wrapper: `before()` for growth + intervention, `after()` for fingerprinting |
| `utils/errors.mjs` | `LoopDetectedError` class |

## Dependencies

- DS003 (Middleware Framework) -- runs as a `both`-type middleware
- DS001 (Request Pipeline) -- middleware execution within the pipeline
- DS009 (Error Handling) -- LoopDetectedError in the error hierarchy
