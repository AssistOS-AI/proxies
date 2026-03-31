# Agent Loop Detector — Design Spec

## Problem

The current loop detector (`pipeline/loop-detector.mjs`) checks for rapid-fire requests (>50/min) and 10+ consecutive identical message arrays. Neither catches real agent loops because:

- Agents in loops make 2-5 calls/min (well under rapid-fire threshold)
- Each call adds tool results to the conversation, making the full messages array unique every time
- The actual loop signature is: **assistant responses repeat while the conversation grows**

## Solution

Redesign the loop detector to analyze **behavioral patterns** — specifically response similarity and conversation growth rate. Drop the rapid-fire check (handled by the rate-limiter middleware).

## Detection Signals

### Signal 1: Response Similarity (post-dispatch)

After each response, extract a **fingerprint**: tool names called (sorted) + first 200 chars of response content, hashed. Store the last `similarityWindow` (default 7) fingerprints per tracking ID.

If `similarityThreshold` (default 5) or more of the last `similarityWindow` fingerprints are identical, flag as loop.

**Why this works:** An agent stuck calling `read_file` on the same path, or retrying the same failed command, produces identical fingerprints. Normal productive work produces diverse fingerprints.

### Signal 2: Conversation Growth Rate (pre-dispatch)

Track `ctx.messages.length` and estimated token count per request. If a session has accumulated >50K tokens of growth AND response fingerprints show >60% repetition rate, flag as loop.

**Why this works:** Normal agent work grows the conversation with diverse responses. A loop grows the conversation with repetitive responses. The combination of "growing fast" + "not making progress" is the distinguishing signal.

## Tracking

**Tracking ID:** `sessionId` when `X-Soul-Session` header is present. Falls back to `apiKeyId:agentName` when not.

**State per tracking ID:**
- `fingerprints`: array of last `similarityWindow` response hashes
- `requestCount`: total requests in this tracking session
- `tokenGrowth`: cumulative estimated tokens across requests
- `lastAccess`: timestamp for eviction
- `loopDetected`: boolean (sticky — once detected, stays true for the session)
- `interventionCount`: how many times we've intervened

**Eviction:** Entries older than 30 minutes cleaned every 5 minutes (same as current).

## Actions (configurable via `mode` setting)

### `mode: 'intervene'` (default)

Don't abort the request. Instead, prepend a system message to `ctx.messages`:

> *[Soul Gateway] Loop detected: your last several responses followed the same pattern. Stop the current approach and try something different.*

The LLM sees this warning and can break the cycle. The message is configurable via `interventionMessage` setting.

### `mode: 'block'`

Abort with 429: `ctx.abort = true`, `ctx.abortStatus = 429`. The agent gets an error and must handle it externally.

### `mode: 'log'`

Log the detection but take no action. For monitoring/tuning thresholds before enabling enforcement.

## Middleware Interface

Type: `both` (needs `before()` for growth tracking + intervention injection, `after()` for response fingerprinting)

```javascript
defaultSettings: {
  enabled: true,
  mode: 'intervene',
  similarityThreshold: 5,
  similarityWindow: 7,
  growthTokenThreshold: 50000,
  interventionMessage: '[Soul Gateway] Loop detected: your last several responses followed the same pattern. Stop and try a different approach.',
}
```

## Files

| File | Action |
|------|--------|
| `pipeline/loop-detector.mjs` | **Rewrite** — new detection engine with fingerprinting + growth tracking |
| `middlewares/loop-detector.mjs` | **Rewrite** — `both` type, `before()` for growth + intervention, `after()` for fingerprinting |

## What's Removed

- Rapid-fire detection (handled by rate-limiter middleware)
- Identical message array detection (replaced by response fingerprinting)
- `checkLoopDetection()` export (replaced by new API)
- `getLoopDetectorStats()` export (replaced or updated)
