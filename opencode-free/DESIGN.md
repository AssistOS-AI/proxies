# OpenCode free upstream agent: design notes

**Status: built.** The agent is described in [docs/index.html](docs/index.html) and its authoritative contracts are indexed in [docs/specs/matrix.md](docs/specs/matrix.md). The notes below are the verified facts and prohibitions from the feasibility work of 21 September 2026 that the build rests on; the open decision recorded at the end was taken as "tools defined but never executable".

## Objective

Make OpenCode's free models usable through the local Soul Gateway with a standalone Ploinky agent that runs the real, unmodified OpenCode CLI and exposes the OpenAI chat-completions surface. Soul Gateway would consume it like any other agent, through Router OpenAI-agent discovery and its generic Ploinky agent backend. Soul Gateway stays free of OpenCode-specific code, and the agent must not depend on any other agent's OpenCode installation or state.

## Why an agent and not a provider

OpenCode's hosted API refuses free-tier inference from any client other than OpenCode itself: `POST https://opencode.ai/zen/v1/chat/completions` (and the `inference/openai` path) answers HTTP 403 `FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"). Only the official CLI may talk to OpenCode on the free tier. Imitating the client (copied headers, user agents, request shapes, hidden credentials) is prohibited.

## Hard prohibitions for any implementation

| Prohibition | Reason |
| --- | --- |
| No direct HTTP inference against OpenCode and no client imitation | The service reserves the free tier for its own client. |
| No reuse of another agent's OpenCode installation, home, plugins or sockets | The agent must be standalone, and routing OpenCode back to Soul Gateway would recurse. |
| No path from the agent back to Soul Gateway | Soul Gateway's loop guard catches an agent calling its own model, not agent → tier → agent. |
| Never `--auto`, `--share`, `--continue`, `--session`, `--attach` or `--interactive` | Auto-approval and session reuse defeat confinement and isolation. |
| No paid usage | The intended credential has a zero budget with paid models disabled; any non-zero reported cost must fail the request closed. |

## Verified facts (OpenCode CLI 1.18.31)

Twelve isolated inference runs were made: a throwaway `HOME`, all four `XDG_*` directories and `TMPDIR` under one fresh root per run, an empty working directory, an allow-listed environment, and the prompt on stdin only. Seven were refused before generation, and five answered at reported cost 0.

| Question | Result |
| --- | --- |
| Credential | `OPENCODE_API_KEY` in the child environment. With a key present the CLI leaves priced models enabled, so the agent must allow-list models itself. |
| Prompt channel | stdin works if it is closed; no conversation text needs to appear in process arguments. |
| Output | `--format json` emits `step_start`, `text` (`part.text`), `tool_use` (`part.tool`, `part.state.status`), `step_finish` (`part.reason`, `part.cost`, `part.tokens`) and `error` events. The exit code is 1 on an API error, and **also 0 when every tool call was rejected and no answer was given**. |
| Text granularity | The answer arrives as one `text` event, just before `step_finish`, not as token deltas. |
| What the service accepts | Acceptance depends on the request carrying OpenCode's built-in tool definitions. A request with no tools, or with only an inert placeholder tool, is refused with 403 `FreeTierError` regardless of the system prompt and regardless of the credential. A short custom system prompt with the 13 built-in tools is accepted. Whether a smaller tool subset is accepted is unknown. |
| Confinement | `"permission": {"*": "ask"}` keeps the tools defined, while `opencode run` without `--auto` rejects every permission request. Two adversarial prompts made the model attempt `bash`, `read` and `write` (outside and inside the working directory); every call was rejected, nothing ran, nothing was written, and the cost was 0. |
| Run-time package install | During configuration loading the CLI forks a detached npm install of `@opencode-ai/plugin` into every *writable* configuration directory (32 packages from the public registry). A read-only configuration directory suppresses it; this was verified with inference. |
| Cost and latency | About 6,100 to 6,500 input tokens per one-sentence exchange, almost all of them tool definitions. 2.6 to 4.3 s to `step_start` with a read-only configuration; 2.7 to 7.5 s in total for a plain answer; 9.7 to 14.7 s when the model tries tools first. |

## Open decision (the user's)

Removing the tools makes the service refuse the request, so "every tool disabled" cannot coexist with the free tier. The alternative is **tools defined but never executable**: the built-in tool definitions stay in the request, while every permission request is rejected. That meets the service's check in form, using only the official client's own behaviour, but it is not agentic use, and confinement rests on the CLI's permission engine (with the container as a second layer). No implementation should start before this is decided.

## Requirements for a build

| Requirement | Reason |
| --- | --- |
| Treat any `tool_use` event, and any `step_finish` whose reason is not `stop` or `length`, as a failed request; never return text from such a run; fail closed if a tool event reports `completed` | Adversarial runs ended with exit 0, reason `tool-calls` and sometimes a non-blank preamble. |
| Generate the configuration into a directory that is read-only to the CLI | Suppresses the run-time npm install, its latency and its network egress. |
| Allow-list the model before spawning; always pass `--title` and pin `small_model` | Priced models stay enabled when a key is present, and title generation could otherwise pick another model. |
| Make readiness depend on a real zero-cost answer, and leave service on `FreeTierError` | The acceptance rule belongs to the service and can change without notice. |
| Keep an adversarial confinement run in the agent's own verification, pinned to the CLI version | Confinement rests on the CLI's permission engine. |
| Report a streamed answer as one chunk, or document it as such | The CLI emits the text in one event. |
| One CLI process per request in its own process group, with a per-request temporary root (home, configuration, data, state, cache, working directory) removed on completion, failure, abort and deadline | Isolation and cleanup. |
| Reject `tools`, `tool_choice`, `functions`, non-text `response_format`, image or audio parts and `n > 1` with HTTP 400 before any CLI run | The CLI cannot serve them as a plain model. |
| Advertise `supports_tools: false` and `supports_vision: false` explicitly in `/v1/models` | Soul Gateway's agent backend defaults tool support to true. |

## Generic prerequisites already in place

Two generic changes that such an agent needs were made in this release, and neither names OpenCode:

- Ploinky's AgentServer lets a failing command handler choose the HTTP status, error type and `Retry-After` through an explicit `"ok": false` failure envelope. A streamed handler that dies after partial output now ends with an error frame instead of looking complete, and nothing follows a stream the handler terminated itself.
- Soul Gateway's Ploinky agent backend treats an in-band `error` frame or body without `choices` as a failed, classified attempt, and a stream that ends without `[DONE]` or a `finish_reason` as truncated (DS007). A handler must not report 404 for a transient condition, because a model-not-found failure does not cascade.

## Residual risks

The acceptance rule was inferred from twelve requests on one day. The free quota is shared and unmeasured, and every request carries about 6,200 tokens of tool definitions. Latency rules out interactive uses such as autocomplete. Prompt flattening from chat messages into one CLI prompt is lossy and unevaluated. The privacy terms of the free models were not checked. No end-to-end path (Router discovery, signed agent calls, Soul Gateway reconciliation) has been run.
