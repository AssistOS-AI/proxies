import { provider as brave } from './brave.mjs';
import { provider as duckduckgo } from './duckduckgo.mjs';
import { provider as exa } from './exa.mjs';
import { provider as jina } from './jina.mjs';
import { provider as searxng } from './searxng.mjs';
import { provider as serper } from './serper.mjs';
import { provider as tavily } from './tavily.mjs';

export const providers = Object.freeze([
    duckduckgo,
    tavily,
    brave,
    exa,
    serper,
    searxng,
    jina,
]);

const providerMap = new Map(providers.map((provider) => [provider.key, provider]));

export function getProvider(key) {
    return providerMap.get(key);
}

export function listProviders(env = process.env) {
    return {
        providers: providers.map((provider) => ({
            provider: provider.key,
            name: provider.name,
            requiredEnv: envStatus(provider.requires || [], env),
        })),
    };
}

function envStatus(names, env) {
    return names.map((name) => ({
        name,
        configured: Boolean(env[name]),
    }));
}
