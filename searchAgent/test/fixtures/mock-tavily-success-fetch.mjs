globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
        ok: true,
        async json() {
            return {
                results: [
                    {
                        title: 'Dogs',
                        url: 'https://example.com/dogs',
                        content: 'Dog breeds overview',
                        observedQueryLength: body.query.length,
                    },
                ],
            };
        },
    };
};
