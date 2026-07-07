async function readToolInputFromStdin() {
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    if (!raw.trim()) return {};
    const payload = JSON.parse(raw);
    return payload?.input ?? payload;
}

function toolErrorPayload(error) {
    return {
        ok: false,
        error: {
            code: error?.code || 'SEARCH_AGENT_TOOL_FAILED',
            message: error?.message || 'SearchAgent tool failed.',
            retryable: Boolean(error?.retryable),
            ...(error?.details && Object.keys(error.details).length ? { details: error.details } : {}),
        },
        results: [],
    };
}

function writeToolPayload(value) {
    process.stdout.write(JSON.stringify(value));
}

export async function runToolSafe(handler) {
    try {
        const input = await readToolInputFromStdin();
        writeToolPayload(await handler(input));
    } catch (error) {
        writeToolPayload(toolErrorPayload(error));
        process.exitCode = 1;
    }
}

export { toolErrorPayload, writeToolPayload, readToolInputFromStdin };
