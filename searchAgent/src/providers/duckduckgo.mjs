import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

export const provider = {
    key: 'duckduckgo',
    name: 'DuckDuckGo',
    requires: [],
    async search({ query, maxResults, fetchImpl = fetch }) {
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            no_redirect: '1',
            no_html: '1',
        });
        const response = await fetchImpl(`https://api.duckduckgo.com/?${params}`, {
            headers: { accept: 'application/json' },
        });
        if (!response.ok) {
            throw new SearchAgentError('PROVIDER_HTTP_ERROR', 'DuckDuckGo search failed.', 502, true);
        }
        const raw = await response.json();
        return normalizeResults(extractDuckDuckGoItems(raw), {}, maxResults);
    },
};

function extractDuckDuckGoItems(raw) {
    const items = [];
    if (raw?.AbstractURL) {
        items.push({
            title: raw.Heading || raw.AbstractSource || raw.AbstractURL,
            url: raw.AbstractURL,
            snippet: raw.AbstractText || '',
            source: raw.AbstractSource,
        });
    }
    appendTopics(items, raw?.RelatedTopics || []);
    return items;
}

function appendTopics(items, topics) {
    for (const topic of topics) {
        if (Array.isArray(topic?.Topics)) {
            appendTopics(items, topic.Topics);
            continue;
        }
        if (!topic?.FirstURL) continue;
        items.push({
            title: String(topic.Text || '').split(' - ')[0] || topic.FirstURL,
            url: topic.FirstURL,
            snippet: topic.Text || '',
        });
    }
}
