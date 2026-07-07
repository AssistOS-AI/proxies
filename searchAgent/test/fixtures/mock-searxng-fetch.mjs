globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    return {
        ok: true,
        async json() {
            return {
                results: [
                    {
                        title: 'SearXNG result',
                        url: 'https://example.com/searxng',
                        content: 'SearXNG useful snippet',
                        observedQuery: parsed.searchParams.get('q'),
                        observedFormat: parsed.searchParams.get('format'),
                        observedCategories: parsed.searchParams.get('categories'),
                        observedLanguage: parsed.searchParams.get('language'),
                        observedTimeRange: parsed.searchParams.get('time_range'),
                        observedSafeSearch: parsed.searchParams.get('safesearch'),
                        observedPage: parsed.searchParams.get('pageno'),
                        observedAccept: options.headers?.accept,
                    },
                ],
            };
        },
    };
};
