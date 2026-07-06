import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'brave',
    name: 'Brave Search',
    requires: ['BRAVE_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const apiKey = env.BRAVE_API_KEY;
        if (!apiKey) throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'BRAVE_API_KEY is not configured.', 503, false);
        const params = new URLSearchParams({ q: query, count: String(maxResults) });
        const response = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params}`, {
            headers: {
                accept: 'application/json',
                'x-subscription-token': apiKey,
            },
        });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'Brave search failed.', 502, true);
        const raw = await response.json();
        return normalizeResults(raw?.web?.results || [], { snippet: ['description', 'snippet'] }, maxResults);
    },
};
