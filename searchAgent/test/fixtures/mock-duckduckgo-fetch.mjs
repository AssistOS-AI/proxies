globalThis.fetch = async () => ({
    ok: true,
    async json() {
        return {
            RelatedTopics: [
                {
                    FirstURL: 'https://example.com/result',
                    Text: 'Example result - useful snippet',
                },
            ],
        };
    },
});
