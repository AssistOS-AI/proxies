import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

const GEMINI_MODEL = 'gemini-2.0-flash';

export const provider = {
    key: 'gemini',
    name: 'Gemini Search',
    requires: ['GEMINI_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'GEMINI_API_KEY is not configured.', 503, false);
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: query }] }],
                tools: [{ google_search: {} }],
            }),
        });
        if (!response.ok) throw await providerHttpError('Gemini Search', response);
        const raw = await response.json();
        return normalizeResults(extractGeminiGroundingResults(raw, query), {}, maxResults);
    },
};

export function extractGeminiGroundingResults(raw, query = '') {
    const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
    const chunks = [];
    const supports = [];
    for (const candidate of candidates) {
        const metadata = candidate?.groundingMetadata || {};
        if (Array.isArray(metadata.groundingChunks)) chunks.push(...metadata.groundingChunks);
        if (Array.isArray(metadata.groundingSupports)) supports.push(...metadata.groundingSupports);
    }

    const byUrl = new Map();
    for (const chunk of chunks) {
        const web = chunk?.web || chunk?.retrievedContext || {};
        const url = web.uri || web.url || '';
        if (!url || byUrl.has(url)) continue;
        byUrl.set(url, {
            title: web.title || url,
            url,
            snippet: web.snippet || '',
        });
    }

    for (const support of supports) {
        const segmentText = support?.segment?.text || '';
        const indexes = Array.isArray(support?.groundingChunkIndices)
            ? support.groundingChunkIndices
            : [];
        for (const index of indexes) {
            const chunk = chunks[index];
            const web = chunk?.web || chunk?.retrievedContext || {};
            const url = web.uri || web.url || '';
            if (!url) continue;
            const existing = byUrl.get(url);
            if (existing && !existing.snippet && segmentText) {
                existing.snippet = segmentText;
            }
        }
    }

    const answer = extractGeminiAnswer(raw);
    if (!byUrl.size && answer) {
        return [{
            title: 'Gemini Search answer',
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
            snippet: answer,
        }];
    }

    return [...byUrl.values()];
}

function extractGeminiAnswer(raw) {
    const parts = raw?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
        .map((part) => (typeof part?.text === 'string' ? part.text.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
}

async function providerHttpError(name, response) {
    const body = await safeResponseText(response);
    return new SearchAgentError('PROVIDER_HTTP_ERROR', `${name} search failed.`, 502, true, {
        providerStatus: response.status,
        providerStatusText: response.statusText || '',
        providerBodyPreview: body.slice(0, 500),
    });
}

async function safeResponseText(response) {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

