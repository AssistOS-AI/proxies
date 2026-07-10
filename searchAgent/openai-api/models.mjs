#!/usr/bin/env node
import { readySearchProviders, searchProviderModelDescriptor } from '../src/lib/provider-models.mjs';
import { readSettings } from '../src/lib/settings.mjs';

try {
    const settings = await readSettings(process.env);
    const readyProviders = await readySearchProviders({ env: process.env });
    process.stdout.write(JSON.stringify({
        object: 'list',
        data: readyProviders.map((provider) => searchProviderModelDescriptor(provider, settings)),
    }));
} catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
}
