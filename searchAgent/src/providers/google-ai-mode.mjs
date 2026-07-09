import http from 'node:http';
import https from 'node:https';

import { isBrowserPoolAvailable } from '../browser/google-ai-mode-config.mjs';
import { SearchAgentError } from '../lib/errors.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

const DEFAULT_POOL_URL = 'http://127.0.0.1:8890';
const DEFAULT_TIMEOUT_MS = 35000;

export const provider = {
    key: 'google-ai-mode',
    name: 'Google AI Mode',
    isReady(env = process.env) {
        return Boolean(String(env.GOOGLE_AI_MODE_POOL_URL || '').trim()) || isBrowserPoolAvailable(env);
    },
    async search({ query, maxResults, env = process.env }) {
        if (!isBrowserPoolAvailable(env) && !String(env.GOOGLE_AI_MODE_POOL_URL || '').trim()) {
            throw new SearchAgentError(
                'PROVIDER_NOT_CONFIGURED',
                'Google AI Mode requires an auto-started browser pool with Chromium and puppeteer-core.',
                503,
                false,
            );
        }

        const poolUrl = resolvePoolUrl(env);
        const payload = await postJson(`${poolUrl}/search/google-ai-mode`, {
            query,
            maxResults,
        }, {
            timeoutMs: parsePositiveInteger(env.BROWSER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) + 10000,
        });

        if (!payload?.ok) {
            const error = payload?.error || {};
            throw new SearchAgentError(
                error.code || 'PROVIDER_HTTP_ERROR',
                error.message || 'Google AI Mode browser pool failed.',
                Number.isFinite(error.statusCode) ? error.statusCode : 502,
                Boolean(error.retryable),
                error.details || {},
            );
        }

        return normalizeResults(Array.isArray(payload.results) ? payload.results : [], {}, maxResults);
    },
};

function resolvePoolUrl(env) {
    const configured = String(env.GOOGLE_AI_MODE_POOL_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const port = parsePositiveInteger(env.BROWSER_POOL_PORT, 8890);
    if (port === 8890) return DEFAULT_POOL_URL;
    return `http://127.0.0.1:${port}`;
}

function postJson(urlString, body, { timeoutMs }) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const data = JSON.stringify(body);
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(data),
            },
            timeout: timeoutMs,
        }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
            });
            response.on('end', () => {
                let parsed = null;
                try {
                    parsed = raw ? JSON.parse(raw) : {};
                } catch {
                    reject(new SearchAgentError(
                        'PROVIDER_HTTP_ERROR',
                        'Google AI Mode browser pool returned invalid JSON.',
                        502,
                        true,
                    ));
                    return;
                }
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(parsed);
                    return;
                }
                const error = parsed?.error || {};
                reject(new SearchAgentError(
                    error.code || 'PROVIDER_HTTP_ERROR',
                    error.message || `Google AI Mode browser pool returned HTTP ${response.statusCode}.`,
                    response.statusCode,
                    Boolean(error.retryable),
                    error.details || {},
                ));
            });
        });

        request.on('timeout', () => {
            request.destroy(new SearchAgentError(
                'PROVIDER_TIMEOUT',
                'Google AI Mode browser pool timed out.',
                504,
                true,
            ));
        });
        request.on('error', (error) => {
            if (error instanceof SearchAgentError) {
                reject(error);
                return;
            }
            reject(new SearchAgentError(
                'PROVIDER_NOT_CONFIGURED',
                'Google AI Mode browser pool is not running.',
                503,
                false,
            ));
        });
        request.end(data);
    });
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
