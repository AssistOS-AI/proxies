globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (target.includes('api.tavily.com')) {
        return jsonResponse({
            results: [
                {
                    title: 'Shared result',
                    url: 'https://example.com/shared',
                    content: `Tavily saw ${body.query}`,
                },
            ],
        });
    }
    if (target.includes('api.search.brave.com')) {
        return jsonResponse({
            web: {
                results: [
                    {
                        title: 'Shared result duplicate',
                        url: 'https://example.com/shared',
                        description: 'Duplicate should be removed',
                    },
                    {
                        title: 'Brave unique',
                        url: 'https://example.com/brave',
                        description: 'Brave unique snippet',
                    },
                ],
            },
        });
    }
    return jsonResponse({});
};

function jsonResponse(body) {
    return {
        ok: true,
        async json() {
            return body;
        },
    };
}

