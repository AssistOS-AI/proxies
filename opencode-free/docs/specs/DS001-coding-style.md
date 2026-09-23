---
title: DS001-coding-style
summary: Defines OpenCode Free source layout, module boundaries, logging, credential handling, documentation, and test conventions.
---

## Introduction

This specification is the coding-style authority for OpenCode Free. It governs maintainable changes without duplicating the runtime contracts owned by later specifications.

## Core Content

JavaScript must use ES modules and four-space indentation, and JSON must use two-space indentation. The agent has no npm dependencies; it relies on Node.js built-ins only. Shell scripts must fail explicitly on required startup errors.

`openai-api/` must hold the two AgentServer command handlers and nothing else: they read the AgentServer payload from standard input and adapt it to the library. Focused modules under `lib/` must own constants, the bundled credential, the model allow-list, request validation and flattening, the CLI runner, event evaluation, response and envelope writing, concurrency slots, and the service-state file. `scripts/` must hold the background service probe loop and the allow-list survey procedure.

Handlers must write response payloads only to standard output and diagnostics only to standard error. A handler's last standard-error line is reserved for the failure envelope, so diagnostic lines must never be JSON objects. Logs must never contain prompt text, answer text, tool arguments or the key.

`lib/credential.mjs` must be the only file that contains the bundled key. It must never be imported by browser code or by model-listing code, and the key must never appear in process arguments, logs, model rows or test output. A test must count the repository files that contain the key by value and require exactly one.

Tests must use descriptive `.test.mjs` names under `test/`, keep every CLI interaction deterministic through the fake CLI and recorded event fixtures, and never contact OpenCode's service except in the opt-in live confinement test that only runs when `OPENCODE_FREE_LIVE=1`. The complete suite must run through `node testAll.mjs`.

Documentation, specifications, comments, and user-facing strings must be English. Source behavior changes must update the relevant HTML explanation and DS contract in the same change. DS prose must remain unwrapped in source, use only `Introduction` and `Core Content` as top-level content sections, and avoid Q&A or conclusion sections.
