---
title: DS004-openai-surface-confinement-and-service-state
summary: Defines the OpenCode Free request validation, prompt flattening, response and error envelopes, event evaluation, service-state file, and model allow-list maintenance.
---

## Introduction

This specification owns the detailed public interfaces and failure boundaries that support the OpenCode Free behaviors: which requests are accepted, how chat messages become one CLI prompt, what the agent returns, how CLI events decide the outcome, how the service state is kept, and how the model allow-list stays current.

## Core Content

### Request validation

The chat handler must answer HTTP 400 `invalid_request_error`, naming the field, before any CLI run when: the request is missing or not an object; `model` is missing, not a string or not allow-listed (the bare id or `opencode/<id>`); `messages` is missing, empty or not an array; a message role is not `system`, `user` or `assistant`; a message carries `tool_calls`, `function_call` or `tool_call_id`; a content part is not text; content is neither a string, an array of text parts nor `{ text }`; the last message is not a user message or its text is empty; `tools` is non-empty; `tool_choice` is present and not `"none"`; `functions` or `function_call` is present; `response_format` is present and not `{ "type": "text" }`; `n` is present and not 1; any text contains a NUL character; or the flattened prompt exceeds 65536 UTF-8 bytes. `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`, `user`, `metadata`, `stream_options`, `parallel_tool_calls`, an empty `tools` array and `tool_choice: "none"` are accepted and ignored. Only the boolean `stream: true` selects streaming.

### Flattened prompt

The [flattened prompt](wiki.html#definition-flattened-prompt) starts with `System instructions:` followed by each system text separated by a blank line, when at least one system message exists, then `User: <text>` and `Assistant: <text>` blocks in order, separated by blank lines, ending with the final user turn. Array contents join their text parts with a line feed. Role boundaries become plain-text labels inside one user turn; the client's system prompt is placed below the agent's own `chat` prompt; `name` fields, tool history, non-text parts and sampling parameters are dropped; the model may echo a label; and a client cannot prefill an assistant turn.

### Failure envelope

Every failure must be reported through AgentServer's failure envelope `{"ok":false,"error":<type>,"message":<text>,"status":<int>,"type":<type>,"retryAfter":<seconds>}`, with `retryAfter` omitted when there is none and a message of at most 1024 characters that never contains the key or prompt text. A buffered failure writes the envelope as the whole standard output; a streamed failure writes nothing to standard output except keepalive comments and writes the envelope as the last standard-error line.

| Condition | Status | Type | Retry-After |
| --- | --- | --- | --- |
| Request validation failure | 400 | `invalid_request_error` | none |
| Service state `unverified` | 503 | `service_unverified` | 30 |
| Service state `unavailable` | 503 | `service_unavailable` | 60 |
| Service state `tripped` | 503 | `service_tripped` | 3600 |
| Service state `refused`, or a run refused with 401/403 | 403 | `free_tier_refused` (`credential_rejected` when the body has no `FreeTierError`) | none |
| Service rate limit | 429 | `rate_limit_error` | the service's `retry-after`, 1 to 86400 s |
| Concurrency cap still full after 20 s | 429 | `rate_limit_error` | 10 |
| Service model-not-found, or a model disabled at run time | 404 | `model_not_found` | none |
| Confinement guard | 502 | `confinement_rejected` (`empty_answer` when no text) | none |
| CLI deadline | 504 | `deadline_exceeded` | none |
| Any other service error, a CLI failure or a spawn failure | 502 | `upstream_error` or `cli_failed` | none |

A 404 is reported only for a service model-not-found answer, because Soul Gateway does not cascade a model-not-found failure; a transient condition must never answer 404.

### Event evaluation

The handler must evaluate the CLI's JSON events in this order and apply the first matching row: a completed tool call (502, trips the state); a positive, negative, non-numeric or non-finite cost (502, trips the state); an error event with status 401 or 403 (403, marks the state refused); an error event with status 429 (429); an error event reporting that the model does not exist (404, disables that model until restart); any other error event (502); the deadline (504); any attempted tool call (502); a finish reason other than `stop` or `length` (502); a non-zero exit without an error event (502, `cli_failed`); no non-empty text (502, `empty_answer`); no finish event (502); otherwise success, returning the text events concatenated in order. A run without any event that exits successfully is therefore an `empty_answer`.

### Service-state file

`/data/service-state.json` must hold `schemaVersion` 1, `state` (`unverified`, `verified`, `refused`, `unavailable` or `tripped`), `since`, `updatedAt`, a `reason` of at most 200 characters, `cliVersion`, a `probe` record (`attempts`, `lastAt`, `nextAt`, `lastOutcomeType`), `disabledModels` and the last `writer`. Writes must be atomic (a temporary file in the same directory, then a rename) and serialized across processes. Writes must be serialized by a lock directory next to the file (`service-state.json.lock`). A lock whose modification time is 10 s old is stale; only one waiter at a time, while it holds a second lock directory (`service-state.json.lock.reclaim`), may remove a stale lock, and only if it is still the same directory that waiter observed. A holder must remove only its own lock, and a writer must wait at most 15 s for the lock. A handler latch (`refused`, `tripped` or a disabled model) that still cannot be written must be logged as `service state latch not persisted`, and the failure envelope must still be returned; the file then keeps the older state, a fail-open in which the next request spawns the CLI again. The lock assumes that a live writer never stays inside its single read and rename for 10 s or more, which only a paused process or a suspended host can violate. A higher state wins over a lower one in the order `tripped`, `refused`, `unavailable`, `verified`, `unverified`; handlers may only write `refused`, `tripped` and disabled models, and only the probe loop may lower the state. At container start the probe loop clears disabled models and resets the state to `unverified`, so that a live probe runs, unless the state is `refused`, its next probe is still in the future and it was recorded by the same CLI version; a missing or invalid file is also reset to `unverified`. Each container start therefore costs one live probe request, so a container that restarts repeatedly probes once per restart; the one-minute to one-hour back-off applies only within one container lifetime. A missing or unreadable file reads as `unverified`.

### Model allow-list

The allow-list is reviewed for CLI 1.18.31 and contains exactly these models:

| Model | Context window | Max output tokens |
| --- | --- | --- |
| `big-pickle` | 200000 | 32000 |
| `ling-3.0-flash-fin-free` | 262144 | 32768 |
| `mimo-v2.5-free` | 200000 | 32000 |
| `muse-spark-1.2-contributor-free` | 1048576 | 131072 |
| `muse-spark-1.3-contributor-free` | 1048576 | 131072 |
| `nemotron-3-ultra-free` | 1000000 | 128000 |
| `nemotron-3.5-lightning-free` | 262144 | 262144 |

On every CLI version bump the maintainer must run `scripts/survey-models.sh`, which lists the models the official CLI reports for the key in a throwaway root (one live listing, ids only, never the key), compare the result with `lib/allow-list.mjs`, update the module, the manifest's agent-card description and this table, and bump `ALLOW_LIST_REVIEWED_FOR_CLI`. A test requires the allow-list to equal the agent-card model list and the reviewed version to equal the pinned CLI version.

### Per-model survey

One live request per model on 22 September 2026 through CLI 1.18.31 with the agent's own configuration (`Reply with exactly the word pong.`): every model answered with finish reason `stop` at reported cost 0. The figures are single samples and only indicate the order of magnitude.

| Model | Time to first step (s) | Total (s) | Total tokens |
| --- | --- | --- | --- |
| `big-pickle` | not measured (handler run) | 4.9 | 6060 |
| `ling-3.0-flash-fin-free` | 3.0 | 3.1 | 6366 |
| `mimo-v2.5-free` | 3.6 | 3.8 | 6383 |
| `muse-spark-1.2-contributor-free` | 3.7 | 4.7 | 6201 |
| `muse-spark-1.3-contributor-free` | 2.7 | 3.3 | 6054 |
| `nemotron-3-ultra-free` | 3.0 | 7.0 | 6493 |
| `nemotron-3.5-lightning-free` | 2.9 | 5.5 | 6506 |

A request in which the model attempts tools before answering took 18 to 23 seconds in the same session.
