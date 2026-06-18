// proxies/default-local-llm/chat-completions.mjs
//
// AgentServer endpoints.chatCompletions.command handler.
// Reads the AgentServer payload { endpoint, request, metadata } from stdin,
// proxies request to the local llama-server OpenAI API, writes the response to
// stdout. Non-zero exit on upstream failure (AgentServer returns a 5xx error).

const LLAMA_BASE_URL = `http://127.0.0.1:${process.env.LLAMA_SERVER_PORT || '8080'}`;

export function parseHandlerInput(stdinText) {
    const payload = JSON.parse(stdinText || '{}');
    const request = payload && typeof payload === 'object' ? payload.request : null;
    if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
        throw new Error('chat-completions: payload.request.messages is required');
    }
    return { request };
}

export async function proxyChatCompletion({ request, baseUrl, fetchImpl = fetch }) {
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!res.ok) {
        const detail = typeof res.text === 'function' ? await res.text() : '';
        throw new Error(`llama-server returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    return { status: res.status, json: await res.json() };
}

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

async function main() {
    let request;
    try {
        ({ request } = parseHandlerInput(await readStdin()));
    } catch (err) {
        process.stderr.write(`chat-completions: bad input: ${err.message}\n`);
        process.exit(2);
    }
    try {
        if (request.stream === true) {
            const res = await fetch(`${LLAMA_BASE_URL}/v1/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
            });
            if (!res.ok || !res.body) {
                process.stderr.write(`chat-completions: upstream ${res.status}\n`);
                process.exit(1);
            }
            // Pipe llama-server SSE straight to stdout; AgentServer forwards it.
            for await (const chunk of res.body) process.stdout.write(chunk);
        } else {
            const { json } = await proxyChatCompletion({ request, baseUrl: LLAMA_BASE_URL });
            process.stdout.write(JSON.stringify(json));
        }
    } catch (err) {
        process.stderr.write(`chat-completions: upstream failure: ${err.message}\n`);
        process.exit(1);
    }
}

// Run main() only as the entry point, not on import (keeps the test pure).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

export default { parseHandlerInput, proxyChatCompletion };
