import http from 'node:http';

import { SearchAgentError, errorResponse } from './lib/errors.mjs';
import { methodNotAllowed, readJsonBody, writeJson } from './lib/http-json.mjs';
import { readSettings, writeSettings } from './lib/settings.mjs';
import { getProvider, listProviders } from './providers/index.mjs';

const SERVER_PORT = 7000;
const SERVER_HOST = '0.0.0.0';

export function createSearchAgentServer({ env = process.env, fetchImpl = fetch } = {}) {
    const config = resolveConfig(env);

    return http.createServer(async (req, res) => {
        const startedAt = Date.now();
        let routeName = 'unknown';
        let logContext = {};
        try {
            const url = new URL(req.url || '/', 'http://search-agent.local');
            routeName = `${req.method || 'GET'} ${url.pathname}`;

            if (url.pathname === '/healthz') {
                if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);
                writeJson(res, 200, { status: 'ready' });
                logRequest('info', 'request_ok', routeName, startedAt);
                return;
            }

            if (url.pathname === '/listProviders') {
                if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);
                const payload = listProviders(env);
                writeJson(res, 200, payload);
                logRequest('info', 'request_ok', routeName, startedAt, {
                    providers: payload.providers.length,
                });
                return;
            }

            if (url.pathname === '/settings') {
                if (req.method === 'GET' || req.method === 'HEAD') {
                    writeJson(res, 200, { settings: await readSettings({ env }) });
                    logRequest('info', 'request_ok', routeName, startedAt, {
                        action: 'readSettings',
                    });
                    return;
                }
                if (req.method === 'POST') {
                    const body = await readJsonBody(req);
                    const settings = await writeSettings(body, { env });
                    writeJson(res, 200, { settings });
                    logRequest('info', 'request_ok', routeName, startedAt, {
                        action: 'writeSettings',
                        settings,
                    });
                    return;
                }
                return methodNotAllowed(res);
            }

            if (url.pathname === '/search') {
                if (req.method !== 'POST') return methodNotAllowed(res);
                const body = await readJsonBody(req);
                logContext = requestSearchLogContext(body);
                const result = await handleSearch(body, { env, fetchImpl, config });
                writeJson(res, 200, result);
                logRequest('info', 'request_ok', routeName, startedAt, {
                    ...logContext,
                    resultCount: result.results.length,
                });
                return;
            }

            writeJson(res, 404, {
                error: {
                    code: 'NOT_FOUND',
                    message: 'Route not found.',
                },
                results: [],
            });
            logRequest('warn', 'request_not_found', routeName, startedAt);
        } catch (error) {
            const status = Number(error?.statusCode) || statusForErrorCode(error?.code);
            writeJson(res, status, errorResponse(error));
            logRequest(status >= 500 ? 'error' : 'warn', 'request_failed', routeName, startedAt, {
                ...logContext,
                status,
                code: error?.code || 'SEARCH_FAILED',
                message: error?.message || 'Search failed.',
                retryable: Boolean(error?.retryable),
                details: error?.details || {},
            });
        }
    });
}

export async function handleSearch(body, { env = process.env, fetchImpl = fetch, config = resolveConfig(env) } = {}) {
    const settings = await readSettings({ env });
    const input = normalizeSearchRequest(body, config, settings);
    const provider = getProvider(input.provider);
    if (!provider) {
        throw new SearchAgentError('UNKNOWN_PROVIDER', 'Unknown search provider.', 404, false);
    }

    const results = await provider.search({
        query: input.query,
        maxResults: input.maxResults,
        env,
        fetchImpl,
    });

    return { results };
}

export function normalizeSearchRequest(body, config = resolveConfig(), settings = {}) {
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const query = typeof body?.query === 'string' ? body.query.trim() : '';

    if (!provider || !query) {
        throw new SearchAgentError('INVALID_REQUEST', 'provider and query are required.', 400, false);
    }

    const maxQueryChars = settings.maxQueryChars || config.maxQueryChars;
    const maxResults = settings.maxResults || config.maxResults;

    if (query.length > maxQueryChars) {
        throw new SearchAgentError(
            'INVALID_REQUEST',
            `query exceeds ${maxQueryChars} characters.`,
            400,
            false,
        );
    }

    return {
        provider,
        query,
        maxResults: normalizeMaxResults(body?.maxResults, maxResults),
    };
}

export function resolveConfig(env = process.env) {
    return {
        host: SERVER_HOST,
        port: SERVER_PORT,
        maxQueryChars: 4000,
        maxResults: 20,
    };
}

function normalizeMaxResults(value, maxResults) {
    const parsed = parseInteger(value, maxResults);
    return Math.max(1, Math.min(maxResults, parsed));
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function statusForErrorCode(code) {
    if (code === 'BODY_TOO_LARGE' || code === 'INVALID_JSON') return 400;
    return 500;
}

function requestSearchLogContext(body) {
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const query = typeof body?.query === 'string' ? body.query : '';
    const maxResults = Number.parseInt(String(body?.maxResults ?? ''), 10);
    return {
        provider,
        queryChars: query.length,
        query: query.length > 2000 ? `${query.slice(0, 2000)}...` : query,
        queryTruncated: query.length > 2000,
        ...(Number.isFinite(maxResults) ? { requestedMaxResults: maxResults } : {}),
    };
}

function logRequest(level, event, routeName, startedAt, fields = {}) {
    const entry = {
        event,
        route: routeName,
        durationMs: Date.now() - startedAt,
        ...fields,
    };
    const line = `[searchAgent] ${JSON.stringify(entry)}`;
    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const config = resolveConfig();
    const server = createSearchAgentServer();
    server.listen(config.port, config.host, () => {
        console.log(`[searchAgent] listening on ${config.host}:${config.port}`);
    });

    const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
