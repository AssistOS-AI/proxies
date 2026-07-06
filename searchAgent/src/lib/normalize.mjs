export function normalizeResult(source, fields = {}) {
    if (!source || typeof source !== 'object') return null;

    const title = pickString(source, fields.title || ['title', 'name']);
    const url = pickString(source, fields.url || ['url', 'link', 'href']);
    const snippet = pickString(source, fields.snippet || ['snippet', 'content', 'description', 'body', 'text']);

    if (!url) return null;

    const result = { ...source };
    result.title = title || url;
    result.url = url;
    result.snippet = snippet || '';

    return result;
}

export function normalizeResults(items, fields = {}, maxResults = 10) {
    if (!Array.isArray(items)) return [];
    const out = [];
    const seen = new Set();
    for (const item of items) {
        const normalized = normalizeResult(item, fields);
        if (!normalized) continue;
        const key = normalized.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
        if (out.length >= maxResults) break;
    }
    return out;
}

export function hostnameFromUrl(value) {
    try {
        return new URL(value).hostname;
    } catch {
        return '';
    }
}

function pickString(source, names) {
    for (const name of names) {
        const value = source?.[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}
