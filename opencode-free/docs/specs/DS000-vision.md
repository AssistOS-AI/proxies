---
title: DS000-vision
summary: Defines the OpenCode Free agent's purpose, users, product boundary, prohibitions, and documentation authority.
---

## Introduction

[OpenCode Free](wiki.html#definition-opencode-free) makes OpenCode's zero-cost models usable as plain-text chat models through the local Soul Gateway. OpenCode reserves its free tier for its own client, so the agent runs the real, unmodified [OpenCode CLI](wiki.html#definition-opencode-cli) once per request inside a dedicated container and exposes the answer through the OpenAI Chat Completions and Models surface of the shared [AgentServer](wiki.html#definition-agentserver).

## Core Content

The agent must serve OpenAI-compatible `/v1/chat/completions` and `/v1/models` through AgentServer command handlers so that Soul Gateway discovers it through the generic Router discovery path and consumes it with its generic Ploinky agent backend. Soul Gateway must not contain OpenCode-specific code, and the agent must not create any path back to Soul Gateway.

Only the official CLI binary may contact OpenCode's service. The agent must not send HTTP inference requests to OpenCode itself, imitate the client, reuse another agent's OpenCode installation, home, plugins or sockets, or use the CLI options `--auto`, `--share`, `--continue`, `--session`, `--attach`, `--interactive`, `--fork`, `--port` or `--print-logs`.

The service accepts a free-tier request only when the CLI's built-in tool definitions are part of it. The agent therefore keeps the tools defined but never executable: the baked configuration asks for permission on every tool and the non-interactive run rejects every request (see [confinement](wiki.html#definition-confinement)). Any run that attempted a tool, reported a cost, or finished for another reason than a completed answer must fail closed; its text is never returned.

The agent must never incur paid usage. It offers only the [allow-listed](wiki.html#definition-allow-list) free models, advertises them as text-only models without tool or vision support, and adds them to no Soul Gateway tier by itself.

Prompts sent to these models are subject to the free models' data-use terms: free-period data may be used to improve the models, some models are for trial use only and must not receive personal or confidential data, and the free quota is shared by every installation that uses the bundled key. The documentation and every model row must state this.

The HTML documentation must explain practical use and runtime behavior, the wiki must remain the canonical terminology source, and the DS files must remain the authoritative requirements.
