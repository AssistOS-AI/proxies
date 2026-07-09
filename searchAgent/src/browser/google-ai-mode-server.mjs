#!/usr/bin/env node
import http from 'node:http';

import { BrowserPool } from './browser-pool.mjs';
import { canResolvePuppeteerCore, isBrowserPoolAvailable, resolveExecutablePath } from './google-ai-mode-config.mjs';
import { durationSince, logEvent, nowMs } from '../lib/logging.mjs';
import { normalizeResults } from '../lib/normalize.mjs';

const DEFAULT_PORT = 8890;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POOL_SIZE = 1;

if (process.argv.includes('--check')) {
    process.exit(isBrowserPoolAvailable(process.env) ? 0 : 1);
}

const executablePath = resolveExecutablePath(process.env);
if (!executablePath) {
    logEvent('google_ai_mode_pool_disabled', { reason: 'browser_executable_not_found' });
    process.exit(1);
}
if (!canResolvePuppeteerCore()) {
    logEvent('google_ai_mode_pool_disabled', { reason: 'puppeteer_core_not_found' });
    process.exit(1);
}

const poolSize = parsePositiveInteger(process.env.BROWSER_POOL_SIZE, DEFAULT_POOL_SIZE);
const port = parsePositiveInteger(process.env.BROWSER_POOL_PORT, DEFAULT_PORT);
const pool = new BrowserPool({
    poolSize,
    executablePath,
    headlessMode: process.env.BROWSER_HEADLESS_MODE || 'new',
    proxyUrl: process.env.BROWSER_PROXY_URL || '',
    userDataDir: process.env.BROWSER_USER_DATA_DIR || '',
    acquireTimeoutMs: parsePositiveInteger(process.env.BROWSER_POOL_ACQUIRE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    log: {
        info(message, fields = {}) {
            logEvent('google_ai_mode_pool_info', { message, ...fields });
        },
    },
});

await pool.warmUp();
logEvent('google_ai_mode_pool_start', {
    port,
    poolSize,
    headlessMode: process.env.BROWSER_HEADLESS_MODE || 'new',
    proxyConfigured: Boolean(process.env.BROWSER_PROXY_URL),
    userDataDirConfigured: Boolean(process.env.BROWSER_USER_DATA_DIR),
});

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
        logEvent('google_ai_mode_pool_request_error', {
            method: request.method,
            path: request.url,
            errorCode: error.code || 'BROWSER_POOL_ERROR',
            retryable: Boolean(error.retryable),
        });
        writeJson(response, error.statusCode || 500, {
            ok: false,
            error: {
                code: error.code || 'BROWSER_POOL_ERROR',
                message: error.message || 'Google AI Mode browser pool failed.',
                retryable: Boolean(error.retryable),
            },
            results: [],
        });
    });
});

server.listen(port, '127.0.0.1', () => {
    logEvent('google_ai_mode_pool_listen', { host: '127.0.0.1', port });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        shutdown().catch(() => {
            process.exit(1);
        });
    });
}

async function shutdown() {
    logEvent('google_ai_mode_pool_shutdown', { pool: pool.status() });
    server.close();
    await pool.closeAll();
    process.exit(0);
}

async function handleRequest(request, response) {
    if (request.method === 'GET' && request.url === '/healthz') {
        writeJson(response, 200, { ok: true, pool: pool.status() });
        return;
    }

    if (request.method !== 'POST' || request.url !== '/search/google-ai-mode') {
        writeJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' }, results: [] });
        return;
    }

    const body = await readJsonBody(request);
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const maxResults = parsePositiveInteger(body?.maxResults, 10);
    if (!query) {
        writeJson(response, 400, {
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'query is required.', retryable: false },
            results: [],
        });
        return;
    }

    const results = await searchGoogleAiMode({ query, maxResults });
    writeJson(response, 200, { ok: true, results });
}

async function searchGoogleAiMode({ query, maxResults }) {
    const startedAt = nowMs();
    const timeout = parsePositiveInteger(process.env.BROWSER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error('Google AI Mode browser request timed out.'));
    }, timeout + 5000);

    let handle = null;
    try {
        logEvent('google_ai_mode_search_start', {
            queryLength: query.length,
            maxResults,
            timeoutMs: timeout,
            pool: pool.status(),
        });
        handle = await pool.acquire(controller.signal);
        logEvent('google_ai_mode_pool_acquired', {
            pool: pool.status(),
        });
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
        await handle.page.goto(url, { waitUntil: 'networkidle2', timeout });
        await dismissGoogleConsent(handle.page);
        const extracted = await extractGoogleAiModeResults(handle.page);
        const results = normalizeResults(formatGoogleAiModeResults(extracted, query), {}, maxResults);
        logEvent('google_ai_mode_search_finish', {
            queryLength: query.length,
            maxResults,
            resultCount: results.length,
            durationMs: durationSince(startedAt),
            status: 'ok',
            pool: pool.status(),
        });
        return results;
    } catch (error) {
        logEvent('google_ai_mode_search_error', {
            queryLength: query.length,
            maxResults,
            durationMs: durationSince(startedAt),
            status: 'error',
            errorCode: error.code || 'GOOGLE_AI_MODE_FAILED',
            retryable: Boolean(error.retryable),
            captchaDetected: error.code === 'PROVIDER_RATE_LIMITED',
            pool: pool.status(),
        });
        throw error;
    } finally {
        clearTimeout(timer);
        if (handle) {
            await pool.release(handle);
        }
    }
}

async function extractGoogleAiModeResults(page) {
    const currentUrl = typeof page.url === 'function' ? page.url() : '';
    if (currentUrl.includes('/sorry/') || currentUrl.includes('/sorry?')) {
        const error = new Error('Google CAPTCHA detected.');
        error.code = 'PROVIDER_RATE_LIMITED';
        error.statusCode = 429;
        error.retryable = true;
        throw error;
    }

    return page.evaluate(() => {
        const answerSelectors = [
            '[data-ai-answer]',
            '.XDKMoc',
            'div[jsname="WbKHeb"]',
            'div[jsname="H7tCnf"]',
            '.QGG6Id.YNk70c',
            '.bzXtMb',
        ];
        const citationSelectors = [
            'a[href][data-ved]',
            'a.KEVENd',
            'a.cz3goc',
        ];

        const answerContainer = answerSelectors
            .map((selector) => document.querySelector(selector))
            .find(Boolean);
        const answer = answerContainer ? answerContainer.textContent.trim() : '';
        const links = [];
        const seen = new Set();
        for (const selector of citationSelectors) {
            for (const item of document.querySelectorAll(selector)) {
                const url = item.href || '';
                if (!url || seen.has(url) || url.includes('google.com/search')) continue;
                seen.add(url);
                links.push({
                    title: item.textContent.trim() || item.getAttribute('aria-label') || url,
                    url,
                });
            }
        }
        return { answer, citations: links };
    });
}

function formatGoogleAiModeResults(extracted, query) {
    const answer = typeof extracted?.answer === 'string' ? extracted.answer.trim() : '';
    const citations = Array.isArray(extracted?.citations) ? extracted.citations : [];
    if (citations.length) {
        return citations.map((citation) => ({
            title: citation.title || citation.url,
            url: citation.url,
            snippet: answer,
        }));
    }
    if (!answer) return [];
    return [{
        title: 'Google AI Mode answer',
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`,
        snippet: answer,
    }];
}

async function dismissGoogleConsent(page) {
    try {
        const clicked = await page.evaluate(() => {
            const candidates = Array.from(
                document.querySelectorAll('button, input[type="submit"], div[role="button"]')
            );
            const target = candidates.find((el) => {
                const text = (el.innerText || el.value || el.textContent || '').trim();
                return /^(accept all|i agree|accept)$/i.test(text) || /tout accepter|alle akzeptieren|aceptar todo/i.test(text);
            });
            if (!target) return false;
            target.click();
            return true;
        });
        if (!clicked) return;
        await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
    } catch {
        // Consent UI varies by locale; the search result path should still report the real failure.
    }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) {
                request.destroy(new Error('Request body too large.'));
            }
        });
        request.on('error', reject);
        request.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(error);
            }
        });
    });
}

function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
