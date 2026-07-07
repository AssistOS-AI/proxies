import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

const SEARXNG_BASE_URL = 'http://127.0.0.1:8888';

export const provider = {
    key: 'searxng',
    name: 'SearXNG',
    async search({ query, maxResults, fetchImpl = fetch }) {
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            categories: 'general',
        });
        const response = await fetchImpl(`${SEARXNG_BASE_URL}/search?${params}`, {
            headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'SearXNG search failed.', 502, true);
        const raw = await response.json();
        return normalizeResults(raw?.results || [], { snippet: ['content', 'snippet'] }, maxResults);
    },
};
