import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

const TAVILY_MAX_QUERY_CHARS = 400;

export const provider = {
    key: 'tavily',
    name: 'Tavily',
    requires: ['TAVILY_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const apiKey = env.TAVILY_API_KEY;
        if (!apiKey) throw missingKey('TAVILY_API_KEY');
        const searchQuery = normalizeTavilyQuery(query);
        const response = await fetchImpl('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                query: searchQuery,
                search_depth: 'basic',
                max_results: maxResults,
                include_answer: false,
            }),
        });
        if (!response.ok) throw await providerHttpError('Tavily', response);
        const raw = await response.json();
        return normalizeResults(raw?.results || [], { url: ['url'], snippet: ['content', 'snippet'] }, maxResults);
    },
};

function missingKey(name) {
    return new SearchAgentError('PROVIDER_NOT_CONFIGURED', `${name} is not configured.`, 503, false);
}

function normalizeTavilyQuery(query) {
    const value = String(query || '').trim();
    return value.slice(0, TAVILY_MAX_QUERY_CHARS).trim();
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
