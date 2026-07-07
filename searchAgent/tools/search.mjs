#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { SearchAgentError } from '../src/lib/errors.mjs';
import { normalizeSearxngSearchOptions, readSearxngSettings } from '../src/lib/searxng-settings.mjs';
import { loadProviderSecretEnv } from '../src/lib/secrets.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';
import { provider as brave } from '../src/providers/brave.mjs';
import { provider as duckduckgo } from '../src/providers/duckduckgo.mjs';
import { provider as exa } from '../src/providers/exa.mjs';
import { provider as jina } from '../src/providers/jina.mjs';
import { provider as searxng } from '../src/providers/searxng.mjs';
import { provider as serper } from '../src/providers/serper.mjs';
import { provider as tavily } from '../src/providers/tavily.mjs';

const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000,
});

const providers = Object.freeze([
    duckduckgo,
    tavily,
    brave,
    exa,
    serper,
    searxng,
    jina,
]);

const providerMap = new Map(providers.map((provider) => [provider.key, provider]));

function resolveSearchConfig() {
    return {
        maxQueryChars: 4000,
        maxResults: 20,
    };
}

function settingsPath(env = process.env) {
    const homePath = String(env.HOME || '').trim();
    if (!homePath) {
        throw new Error('HOME is required for SearchAgent settings.');
    }
    return path.join(homePath, 'search-agent-settings.json');
}

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        maxResults: normalizeInteger(input.maxResults, DEFAULT_SETTINGS.maxResults, 1, 100),
        maxQueryChars: normalizeInteger(input.maxQueryChars, DEFAULT_SETTINGS.maxQueryChars, 1, 20000),
    };
}

async function readSettings(env = process.env) {
    try {
        const raw = await fs.readFile(settingsPath(env), 'utf8');
        return normalizeSettings(JSON.parse(raw));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return normalizeSettings();
        }
        throw error;
    }
}

async function handleSearch(body, {
    env = process.env,
    fetchImpl = fetch,
    config = resolveSearchConfig(),
    dpuClient = null,
} = {}) {
    const settings = await readSettings(env);
    const searxngSettings = await readSearxngSettings(env);
    const input = normalizeSearchRequest(body, config, settings);
    const provider = providerMap.get(input.provider);
    if (!provider) {
        throw new SearchAgentError('UNKNOWN_PROVIDER', 'Unknown search provider.', 404, false);
    }

    const providerEnv = await loadProviderSecretEnv({
        env,
        dpuClient,
        keys: [...(provider.requires || []), ...(provider.optionalSecrets || [])],
    });
    const results = await provider.search({
        query: input.query,
        maxResults: input.maxResults,
        searxng: normalizeSearxngSearchOptions(input.searxng, searxngSettings),
        env: providerEnv,
        fetchImpl,
    });

    return { ok: true, results };
}

function normalizeSearchRequest(body, config = resolveSearchConfig(), settings = {}) {
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
        searxng: {
            categories: body?.categories,
            language: body?.language,
            timeRange: body?.timeRange,
            safeSearch: body?.safeSearch,
            page: body?.page,
        },
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

await runToolSafe((input) => handleSearch(input));
