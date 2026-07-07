import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'jina',
    name: 'Jina Search',
    requires: [],
    optionalSecrets: ['JINA_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const headers = { accept: 'application/json' };
        if (env.JINA_API_KEY) headers.authorization = `Bearer ${env.JINA_API_KEY}`;
        const response = await fetchImpl(`https://s.jina.ai/${encodeURIComponent(query)}`, { headers });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'Jina search failed.', 502, true);
        const raw = await response.json();
        const items = Array.isArray(raw?.data) ? raw.data : raw?.data ? [raw.data] : [];
        return normalizeResults(items, { snippet: ['content', 'description', 'snippet'] }, maxResults);
    },
};
