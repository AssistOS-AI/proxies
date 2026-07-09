import { SearchAgentError } from '../lib/errors.mjs';
import { durationSince, logEvent, nowMs } from '../lib/logging.mjs';
import { normalizeResults } from '../lib/normalize.mjs';
import { apiSearchProviders } from './api-providers.mjs';

const DEFAULT_PROVIDER_KEYS = Object.freeze([
    'tavily',
    'brave',
    'exa',
    'serper',
    'jina',
    'duckduckgo',
    'searxng',
    'gemini',
]);

const providersByKey = new Map(apiSearchProviders.map((provider) => [provider.key, provider]));

export const provider = {
    key: 'deep-research',
    name: 'Deep Research',
    optionalSecrets: uniqueSecretKeys(apiSearchProviders),
    isReady(env = process.env) {
        return getReadyProviders(env).length > 0;
    },
    async search({ query, maxResults, env = process.env, fetchImpl = fetch }) {
        const startedAt = nowMs();
        const requestedKeys = getDeepResearchProviderKeys(env);
        const missingProviders = requestedKeys
            .filter((key) => !providersByKey.has(key))
            .map((key) => ({ provider: key, reason: 'unknown_provider' }));
        const knownProviders = requestedKeys
            .map((key) => providersByKey.get(key))
            .filter(Boolean);
        const skippedProviders = knownProviders
            .filter((candidate) => !hasRequiredSecrets(candidate, env))
            .map((candidate) => ({ provider: candidate.key, reason: 'missing_required_secret' }));
        const selected = knownProviders.filter((candidate) => hasRequiredSecrets(candidate, env));

        logEvent('deep_research_plan', {
            requestedProviders: requestedKeys,
            selectedProviders: selected.map((candidate) => candidate.key),
            skippedProviders: [...missingProviders, ...skippedProviders],
            queryLength: query.length,
            maxResults,
        }, { env });

        if (!selected.length) {
            throw new SearchAgentError('PROVIDER_NOT_CONFIGURED', 'No deep-research providers are ready.', 503, false);
        }

        const perProviderLimit = Math.max(1, Math.min(5, maxResults || 5));
        const settled = await Promise.allSettled(selected.map(async (candidate) => {
            const results = await candidate.search({
                query,
                maxResults: perProviderLimit,
                env,
                fetchImpl,
            });
            return results.map((result) => ({
                ...result,
                sourceProvider: candidate.key,
            }));
        }));

        const collected = [];
        const fulfilledProviders = [];
        const failedProviders = [];
        for (const [index, item] of settled.entries()) {
            const providerKey = selected[index].key;
            if (item.status === 'fulfilled') collected.push(...item.value);
            if (item.status === 'fulfilled') {
                fulfilledProviders.push(providerKey);
            } else {
                failedProviders.push({
                    provider: providerKey,
                    errorCode: item.reason?.code || 'PROVIDER_FAILED',
                    retryable: Boolean(item.reason?.retryable),
                });
            }
        }

        const results = normalizeResults(collected, {}, maxResults);
        logEvent('deep_research_finish', {
            selectedProviders: selected.map((candidate) => candidate.key),
            fulfilledProviders,
            failedProviders,
            resultCount: results.length,
            durationMs: durationSince(startedAt),
        }, { env });

        return results;
    },
};

function getReadyProviders(env) {
    return getDeepResearchProviderKeys(env)
        .map((key) => providersByKey.get(key))
        .filter(Boolean)
        .filter((candidate) => hasRequiredSecrets(candidate, env));
}

function getDeepResearchProviderKeys(env) {
    const raw = typeof env.DEEP_RESEARCH_PROVIDERS === 'string'
        ? env.DEEP_RESEARCH_PROVIDERS
        : '';
    const keys = raw
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    return keys.length ? keys : [...DEFAULT_PROVIDER_KEYS];
}

function hasRequiredSecrets(candidate, env) {
    return (candidate.requires || []).every((key) => Boolean(env[key]));
}

function uniqueSecretKeys(candidates) {
    return [...new Set(candidates.flatMap((candidate) => [
        ...(candidate.requires || []),
        ...(candidate.optionalSecrets || []),
    ]))];
}
