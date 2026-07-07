#!/usr/bin/env node
import { writeSearxngSettings } from '../src/lib/searxng-settings.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';

await runToolSafe(async (input) => ({
    ok: true,
    settings: await writeSearxngSettings(input, process.env),
}));
