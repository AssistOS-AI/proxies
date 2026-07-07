globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    async text() {
        return '{"error":"invalid api key"}';
    },
});
