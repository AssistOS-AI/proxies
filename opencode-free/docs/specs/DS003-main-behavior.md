---
title: DS003-main-behavior
summary: Defines the plain-text chat answer, the model listing, and the confinement and service-state behaviors that produce the OpenCode Free agent's primary outcome.
---

## Introduction

[OpenCode Free](wiki.html#definition-opencode-free) lets a Soul Gateway client, or any caller of AgentServer's OpenAI-compatible surface, send a text-only chat request to one of OpenCode's free models and receive one assistant answer, while no tool the CLI defines can ever run.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Plain-text chat answer | A client sends chat messages for an allow-listed model and receives the model's whole answer as one assistant message, buffered or as one streamed content delta. |
| Model listing | Soul Gateway discovers the allow-listed models with their limits, marked as free, text-only and without tool support, only while the service is verified. |
| Fail-closed confinement | A run that attempted a tool, reported a cost or did not complete an answer is rejected, and its text is never returned. |
| Service state | A background probe establishes whether OpenCode's service answers the agent's request shape at zero cost, and requests are refused without spending quota while it does not. |

### Plain-text chat answer

A client initiates `/v1/chat/completions` through AgentServer with an allow-listed `model` and text-only `system`, `user` and `assistant` messages whose last message is the user turn. The agent must reject tool calling, non-text content, `n` other than 1 and non-text response formats with HTTP 400 before any CLI run, flatten the messages into one [flattened prompt](wiki.html#definition-flattened-prompt), check the service state and a concurrency slot, run the CLI once, and return the answer. A buffered request receives one `chat.completion`; a streamed request receives a role frame, one content frame carrying the whole answer, a finish frame with usage, and `data: [DONE]`, preceded by `: keepalive` comments every ten seconds while the CLI runs. Usage reports prompt tokens as input plus cache reads and writes, completion tokens as output plus reasoning, and the total as the CLI reports it.

### Model listing

Soul Gateway initiates `/v1/models` on its discovery schedule. The handler must list one row per allow-listed model that has not been disabled at run time, only while the service state is `verified`, and an empty list in every other state. Each row must carry both key casings Soul Gateway reads, with tool and vision support set to false, streaming set to true, the model's context window and output limit, `isFree: true`, and the tags `opencode-free`, `text-only` and `no-tools`, none of which creates a Soul Gateway tier. The handler must always exit successfully with valid JSON, because a failing listing makes Soul Gateway create a placeholder `default` model.

### Fail-closed confinement

Every chat run is evaluated against its CLI events in a fixed order. A tool call that completed or a positive or malformed cost fails the request and trips the service state until the container restarts. A service refusal (401 or 403) fails the request and marks the service refused. A rate limit, a model-not-found answer, any other service error, the deadline, any attempted tool call, any finish reason other than `stop` or `length`, a non-zero exit without a service error, and a run without text each fail the request with a classified error. Only a run that passes every check returns its text. Rejected permission requests are logged by tool name only.

### Service state

The probe loop initiates one live request with the smallest prompt at container start and records the outcome in `/data/service-state.json`. While the state is `unverified`, `unavailable`, `refused` or `tripped`, chat requests are refused with an error envelope before any CLI run and the model listing is empty. The loop re-probes an unavailable service with a back-off from one minute to one hour and a refused service after 24 hours; a tripped state lasts until the container restarts. Readiness never depends on this state.
