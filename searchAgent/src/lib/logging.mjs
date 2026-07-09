export function logEvent(event, fields = {}, { env = process.env } = {}) {
    if (String(env.SEARCH_AGENT_LOGS || '').trim() === '0') return;

    const payload = {
        ts: new Date().toISOString(),
        agent: 'searchAgent',
        event,
        ...normalizeFields(fields),
    };

    try {
        process.stderr.write(`${JSON.stringify(payload)}\n`);
    } catch {
        // Logging must never break MCP stdout payloads.
    }
}

export function nowMs() {
    return Number(process.hrtime.bigint() / 1_000_000n);
}

export function durationSince(startMs) {
    return Math.max(0, nowMs() - startMs);
}

function normalizeFields(fields) {
    const normalized = {};
    for (const [key, value] of Object.entries(fields || {})) {
        if (value === undefined) continue;
        normalized[key] = normalizeValue(value);
    }
    return normalized;
}

function normalizeValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            code: value.code,
            message: value.message,
        };
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeValue(item));
    }
    if (value && typeof value === 'object') {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) continue;
            output[key] = normalizeValue(item);
        }
        return output;
    }
    return value;
}
