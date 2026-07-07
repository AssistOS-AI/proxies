#!/usr/bin/env node
import { readSearxngSettings } from '../src/lib/searxng-settings.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';

await runToolSafe(async () => ({
    ok: true,
    settings: await readSearxngSettings(process.env),
}));
