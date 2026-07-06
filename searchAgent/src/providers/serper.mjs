import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'serper',
    name: 'Serper',
    requires: ['SERPER_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const apiKey = env.SERPER_API_KEY;
        if (!apiKey) throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'SERPER_API_KEY is not configured.', 503, false);
        const response = await fetchImpl('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify({ q: query, num: maxResults }),
        });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'Serper search failed.', 502, true);
        const raw = await response.json();
        return normalizeResults(raw?.organic || [], { url: ['link', 'url'] }, maxResults);
    },
};
