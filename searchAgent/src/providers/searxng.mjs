import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'searxng',
    name: 'SearXNG',
    requires: ['SEARXNG_URL'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const baseUrl = String(env.SEARXNG_URL || '').replace(/\/+$/, '');
        if (!baseUrl) throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'SEARXNG_URL is not configured.', 503, false);
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            categories: 'general',
        });
        const response = await fetchImpl(`${baseUrl}/search?${params}`, {
            headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'SearXNG search failed.', 502, true);
        const raw = await response.json();
        return normalizeResults(raw?.results || [], { snippet: ['content', 'snippet'] }, maxResults);
    },
};
