#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { SearchAgentError } from '../src/lib/errors.mjs';
import { durationSince, logEvent, nowMs } from '../src/lib/logging.mjs';
import { loadProviderSecretEnv } from '../src/lib/secrets.mjs';
import { readSettings } from '../src/lib/settings.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';
import { providerMap } from '../src/providers/registry.mjs';

function resolveSearchConfig() {
    return {
        maxQueryChars: 4000,
        maxResults: 20,
    };
}

async function handleSearch(body, {
    env = process.env,
    fetchImpl = fetch,
    config = resolveSearchConfig(),
    dpuClient = null,
} = {}) {
    const startedAt = nowMs();
    let input = null;
    let provider = null;
    let secretKeys = [];
    try {
        const settings = await readSettings(env);
        input = normalizeSearchRequest(body, config, settings);
        provider = providerMap.get(input.provider);
        if (!provider) {
            throw new SearchAgentError('UNKNOWN_PROVIDER', 'Unknown search provider.', 404, false);
        }

        secretKeys = [...(provider.requires || []), ...(provider.optionalSecrets || [])];
        logEvent('search_start', {
            provider: input.provider,
            queryLength: input.query.length,
            maxResults: input.maxResults,
            secretKeysRequested: secretKeys.length,
        }, { env });

        const providerEnv = await loadProviderSecretEnv({
            env,
            dpuClient,
            keys: secretKeys,
        });
        const results = await provider.search({
            query: input.query,
            maxResults: input.maxResults,
            env: providerEnv,
            fetchImpl,
        });

        logEvent('search_finish', {
            provider: input.provider,
            queryLength: input.query.length,
            maxResults: input.maxResults,
            resultCount: Array.isArray(results) ? results.length : 0,
            durationMs: durationSince(startedAt),
            status: 'ok',
        }, { env });

        return { ok: true, provider: input.provider, results };
    } catch (error) {
        logEvent('search_error', {
            provider: input?.provider || normalizeProviderForLog(body),
            queryLength: input?.query?.length ?? normalizeQueryLengthForLog(body),
            maxResults: input?.maxResults,
            durationMs: durationSince(startedAt),
            status: 'error',
            errorCode: error?.code || 'SEARCH_AGENT_TOOL_FAILED',
            retryable: Boolean(error?.retryable),
        }, { env });
        throw error;
    }
}

function isMainModule() {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function normalizeSearchRequest(body, config = resolveSearchConfig(), settings = {}) {
    const provider = normalizeProvider(body?.provider);
    const query = typeof body?.query === 'string' ? body.query.trim() : '';

    if (!provider) {
        throw new SearchAgentError('INVALID_REQUEST', 'provider is required.', 400, false);
    }
    if (!query) {
        throw new SearchAgentError('INVALID_REQUEST', 'query is required.', 400, false);
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

function normalizeMaxResults(value, maxResults) {
    const parsed = parseInteger(value, maxResults);
    return Math.max(1, Math.min(maxResults, parsed));
}

function normalizeProvider(value) {
    const provider = typeof value === 'string' ? value.trim() : '';
    return provider;
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProviderForLog(body) {
    return typeof body?.provider === 'string' && body.provider.trim()
        ? body.provider.trim()
        : null;
}

function normalizeQueryLengthForLog(body) {
    return typeof body?.query === 'string' ? body.query.trim().length : null;
}

if (isMainModule()) {
    await runToolSafe((input) => handleSearch(input));
}

export { handleSearch };
