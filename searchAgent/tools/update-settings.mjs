#!/usr/bin/env node
import { writeSettings } from '../src/lib/settings.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';

await runToolSafe(async (input) => ({
    ok: true,
    settings: await writeSettings(input, process.env),
}));
