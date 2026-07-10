import { loadProviderSecretEnv } from './secrets.mjs';
import { providers } from '../providers/registry.mjs';

function requiredSecretStatus(provider, env) {
    return (provider.requires || []).map((name) => ({
        name,
        configured: Boolean(env[name]),
    }));
}

export function isProviderReady(provider, env) {
    if (typeof provider.isReady === 'function') {
        return Boolean(provider.isReady(env));
    }
    return requiredSecretStatus(provider, env).every((secret) => secret.configured);
}

export async function readySearchProviders({ env = process.env, dpuClient = null } = {}) {
    const providerEnv = await loadProviderSecretEnv({
        env,
        dpuClient,
    });
    return providers.filter((provider) => isProviderReady(provider, providerEnv));
}

function pricingForProvider(provider) {
    const requiresApiKey = Array.isArray(provider?.requires) && provider.requires.length > 0;
    const mode = requiresApiKey ? 'external_directory' : 'free';
    return {
        mode,
        isFree: mode === 'free',
    };
}

export function searchProviderModelDescriptor(provider, settings = {}) {
    const pricing = pricingForProvider(provider);
    return {
        id: provider.key,
        object: 'model',
        modelId: provider.key,
        providerModelId: provider.key,
        displayName: provider.name || provider.key,
        supportsTools: false,
        supportsStreaming: true,
        supportsVision: false,
        pricing: { mode: pricing.mode },
        pricingMode: pricing.mode,
        isFree: pricing.isFree,
        tags: ['search'],
        capabilities: {
            search: true,
            retrieval: true,
            supportsStreaming: true,
            supportsTools: false,
            supportsVision: false,
        },
        metadata: {
            provider: provider.key,
            searchAgentProvider: true,
            maxResults: settings.maxResults ?? null,
            maxQueryChars: settings.maxQueryChars ?? null,
        },
    };
}
