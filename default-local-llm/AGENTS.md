# default-local-llm

Standalone default local LLM agent. Runs llama.cpp `llama-server` (loopback) serving
Qwen2.5-1.5B-Instruct (Q4_K_M GGUF, baked into the image) behind ploinky's shared
AgentServer via `endpoints.chatCompletions.command`.

- `startup.sh` — launch llama-server, wait for `/health`, then run AgentServer.
- `chat-completions.mjs` — AgentServer handler; proxies OpenAI requests to local llama-server.
- Image built in `container-image-builds` (`images/default-local-llm`), published as
  `assistos/default-local-llm`.

No dependency on `llm-runtime` or `local-llm-architectures`. Inherits workspace commit policy
(no AI attribution).
