#!/usr/bin/env node
import { loadProviderSecretEnv } from '../src/lib/secrets.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';
import { provider as brave } from '../src/providers/brave.mjs';
import { provider as duckduckgo } from '../src/providers/duckduckgo.mjs';
import { provider as exa } from '../src/providers/exa.mjs';
import { provider as jina } from '../src/providers/jina.mjs';
import { provider as searxng } from '../src/providers/searxng.mjs';
import { provider as serper } from '../src/providers/serper.mjs';
import { provider as tavily } from '../src/providers/tavily.mjs';

const providers = Object.freeze([
    duckduckgo,
    tavily,
    brave,
    exa,
    serper,
    searxng,
    jina,
]);

function requiredSecretStatus(provider, env) {
    return (provider.requires || []).map((name) => ({
        name,
        configured: Boolean(env[name]),
    }));
}

function isProviderReady(provider, env) {
    return requiredSecretStatus(provider, env).every((secret) => secret.configured);
}

async function run() {
    const providerEnv = await loadProviderSecretEnv({
        env: process.env,
        dpuClient: null,
    });

    return {
        ok: true,
        providers: providers
            .filter((provider) => isProviderReady(provider, providerEnv))
            .map((provider) => ({
                provider: provider.key,
                name: provider.name,
            })),
    };
}

await runToolSafe(() => run());
