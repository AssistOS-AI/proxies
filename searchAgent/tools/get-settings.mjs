#!/usr/bin/env node
import { readProviderSecretHints } from '../src/lib/secrets.mjs';
import { readSettings } from '../src/lib/settings.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';

await runToolSafe(async () => ({
    ok: true,
    settings: await readSettings(process.env),
    secrets: await readProviderSecretHints(),
}));
