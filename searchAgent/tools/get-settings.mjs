#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { readProviderSecretHints } from '../src/lib/secrets.mjs';
import { runToolSafe } from '../src/lib/tool-io.mjs';

const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000,
});

function settingsPath(env = process.env) {
    const homePath = String(env.HOME || '').trim();
    if (!homePath) {
        throw new Error('HOME is required for SearchAgent settings.');
    }
    return path.join(homePath, 'search-agent-settings.json');
}

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        maxResults: normalizeInteger(input.maxResults, DEFAULT_SETTINGS.maxResults, 1, 100),
        maxQueryChars: normalizeInteger(input.maxQueryChars, DEFAULT_SETTINGS.maxQueryChars, 1, 20000),
    };
}

async function readSettings(env = process.env) {
    try {
        const raw = await fs.readFile(settingsPath(env), 'utf8');
        return normalizeSettings(JSON.parse(raw));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return normalizeSettings();
        }
        throw error;
    }
}

await runToolSafe(async () => ({
    ok: true,
    settings: await readSettings(process.env),
    secrets: await readProviderSecretHints(),
}));
