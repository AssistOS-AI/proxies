import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'exa',
    name: 'Exa',
    requires: ['EXA_API_KEY'],
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const apiKey = env.EXA_API_KEY;
        if (!apiKey) throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'EXA_API_KEY is not configured.', 503, false);
        const response = await fetchImpl('https://api.exa.ai/search', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify({
                query,
                num_results: maxResults,
                use_autoprompt: true,
                type: 'neural',
            }),
        });
        if (!response.ok) throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'Exa search failed.', 502, true);
        const raw = await response.json();
        return normalizeResults(raw?.results || [], { snippet: ['text', 'snippet'] }, maxResults);
    },
};
