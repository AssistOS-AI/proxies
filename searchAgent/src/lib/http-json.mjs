const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
            const error = new Error('Request body is too large.');
            error.code = 'BODY_TOO_LARGE';
            throw error;
        }
        chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        const error = new Error('Request body must be valid JSON.');
        error.code = 'INVALID_JSON';
        throw error;
    }
}

export function writeJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

export function methodNotAllowed(res) {
    writeJson(res, 405, {
        error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'Method not allowed.',
        },
        results: [],
    });
}
