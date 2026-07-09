#!/usr/bin/env node
import { loadProviderSecretEnv } from '../src/lib/secrets.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';
import { providers } from '../src/providers/registry.mjs';

function requiredSecretStatus(provider, env) {
    return (provider.requires || []).map((name) => ({
        name,
        configured: Boolean(env[name]),
    }));
}

function isProviderReady(provider, env) {
    if (typeof provider.isReady === 'function') {
        return Boolean(provider.isReady(env));
    }
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
