globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    return {
        ok: true,
        async json() {
            return {
                observedUrl: String(url),
                candidates: [
                    {
                        content: {
                            parts: [{ text: body.contents[0].parts[0].text }],
                        },
                        groundingMetadata: {
                            groundingChunks: [
                                {
                                    web: {
                                        title: 'Gemini source',
                                        uri: 'https://example.com/gemini',
                                    },
                                },
                            ],
                            groundingSupports: [
                                {
                                    segment: { text: 'Grounded Gemini snippet' },
                                    groundingChunkIndices: [0],
                                },
                            ],
                        },
                    },
                ],
            };
        },
    };
};

