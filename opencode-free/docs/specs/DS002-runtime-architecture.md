---
title: DS002-runtime-architecture
summary: Defines the OpenCode Free image, container layout, startup, readiness, per-request CLI process model, deadlines, and concurrency.
---

## Introduction

OpenCode Free is a Ploinky agent that Explorer enables by default as a no-wait dependency. Its runtime combines a dedicated image that carries the pinned OpenCode CLI and a read-only CLI configuration, the shared [AgentServer](wiki.html#definition-agentserver), a background [service probe loop](wiki.html#definition-service-state), and one isolated CLI process per request.

## Core Content

### Image

The manifest must pin `docker.io/assistos/opencode-free-agent` by digest. The image must be built from the digest-pinned `ploinky-node` base, install OpenCode CLI 1.18.31 from the official GitHub release tarball verified by its SHA-256 before extraction (arm64 `d4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6`, amd64 `e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4`), place the binary at `/opt/opencode/bin/opencode`, record the release asset, its digest and the installed binary's SHA-256 in `/opt/opencode-free/source.contract`, and run as `USER 1000:1000`. The CLI configuration must be baked at `/opt/opencode-free/config/opencode/opencode.json`, owned by root, with the directory at mode `0555` and the file at `0444`. The mode must live in the image layer because host bind mounts on macOS do not enforce modes; a writable configuration directory makes the CLI install a plugin package from the public npm registry at run time.

### Container layout

`/code` is the agent directory and `/Agent` is AgentServer, both mounted read-only by Ploinky. Per-request roots live under `/var/tmp/opencode-free/runs/` and concurrency slots under `/var/tmp/opencode-free/slots/`, both in the container's writable layer and never on a host mount. `/data` is the agent's persistent volume (`runtime.resources.persistentStorage`, key `opencode-free`) and holds only `service-state.json`.

### Startup

`startup.sh` must create the writable-layer directories, start AgentServer on the Ploinky agent port (7000 by default), start `scripts/service-probe-loop.mjs` in the background, forward `TERM` and `INT` to both, and exit with 1 when either AgentServer or the probe loop exits on its own, so that Ploinky restarts the container instead of leaving the service state without an owner. A requested stop (`TERM` or `INT`, which Ploinky's managed restart sends) must end with AgentServer's own exit status, 0 on a clean shutdown, because the managed drain accepts only exit code 0.

### Readiness

The manifest readiness script `readiness.sh` must check local facts only and must never contact OpenCode's service or read the key: AgentServer `/health` answers `ok: true`; the CLI binary's SHA-256 equals `binary_sha256` in `source.contract`; the configuration directory and file are not writable; and `opencode debug agent chat --pure`, run without a key in a throwaway root, resolves the `chat` agent with the thirteen built-in tools and ends its permission rules with the wildcard `ask` rule.

The manifest must not declare `readiness.protocol`. Ploinky resolves an explicit protocol before it looks for a script, and runs the script as the readiness gate only when the resolved protocol is `script`; declaring `tcp` or `mcp` would reduce activation and restart readiness to a port connect and leave the binary and configuration checks out of both gates. With the script as the gate, the same script serves three purposes: the no-wait activation gate, whose failure is terminal for Explorer's deployment gate; the readiness of a managed restart; and the container monitor's recurring runtime probe, which runs every few minutes and whose failure causes a managed restart rather than a terminal state. The probe budget (`interval` 1 s, `timeout` 15 s, `failureThreshold` 60) bounds a never-ready container at 16 minutes, below the deployment gate's own wait, and every attempt spawns one `debug agent` run and no inference. The live service check is kept out of readiness for the same reason and drives the [service state](wiki.html#definition-service-state) instead.

### Per-request CLI process

Each chat request must run `opencode run --pure --format json -m opencode/<id> --title chat --dir <root>/work --agent chat` once, as a new process group, with the prompt written to standard input and standard input closed. The per-request root `runs/<random id>/` holds empty `home`, `data`, `state`, `cache`, `tmp` and `work` directories. The child environment must be built from an empty set and contain exactly these names: `PATH`, `HOME`, `XDG_CONFIG_HOME` (the baked read-only directory), `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `LANG`, `NO_COLOR`, `TERM`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_TERMINAL_TITLE` and `OPENCODE_API_KEY`. Nothing from AgentServer's own environment may reach the CLI.

The CLI deadline is 90 seconds (`OPENCODE_FREE_CLI_DEADLINE_MS`). On the deadline, on `SIGTERM` from AgentServer, or on any uncaught error, the handler must send `SIGTERM` to the process group, wait two seconds, send `SIGKILL` to the group, tolerate `ESRCH` and `EPERM`, and remove the per-request root. The root and the slot must be removed on every exit path.

### Deadlines

The slot wait (at most 20 seconds) plus the CLI deadline (90 seconds) must stay below the manifest's `chatCompletions.timeoutMs` of 115 seconds, which is AgentServer's backstop, and that must stay below Soul Gateway's 120-second attempt deadline. The Router adds no shorter limit on the agent path. AgentServer has no abort hook for buffered requests, so a direct caller that abandons a buffered request leaves its CLI run going until the deadline; Soul Gateway always streams to this agent.

### Concurrency

At most two CLI processes may run per container (`OPENCODE_FREE_SLOT_CAP`). A request takes a slot by atomically creating `slots/slot-<n>` with an `owner.json` recording its process, start time and request id; a slot whose owner process is gone, whose owner record never appeared within five seconds, or whose start is older than 130 seconds is reclaimed. A request that finds no free slot within 20 seconds fails with a rate-limit error. The probe loop takes a slot like a handler.
