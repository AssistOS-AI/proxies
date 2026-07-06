export class SearchAgentError extends Error {
    constructor(code, message, statusCode = 500, retryable = false, details = {}) {
        super(message);
        this.name = 'SearchAgentError';
        this.code = code;
        this.statusCode = statusCode;
        this.retryable = retryable;
        this.details = details && typeof details === 'object' ? details : {};
    }
}

export function errorResponse(error) {
    const response = {
        error: {
            code: error?.code || 'SEARCH_FAILED',
            message: error?.message || 'Search failed.',
            retryable: Boolean(error?.retryable),
        },
        results: [],
    };
    if (error?.details && Object.keys(error.details).length) {
        response.error.details = error.details;
    }
    return response;
}
