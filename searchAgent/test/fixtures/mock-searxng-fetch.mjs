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
                        observedAccept: options.headers?.accept,
                    },
                ],
            };
        },
    };
};
