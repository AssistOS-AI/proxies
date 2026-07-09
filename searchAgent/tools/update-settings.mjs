#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { runToolSafe } from '../src/lib/tool-io.mjs';

const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000,
    currentProvider: 'searxng',
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
        currentProvider: normalizeProvider(input.currentProvider, DEFAULT_SETTINGS.currentProvider),
    };
}

function normalizeProvider(value, fallback) {
    const provider = typeof value === 'string' ? value.trim() : '';
    return provider || fallback;
}

async function writeSettings(settings, env = process.env) {
    const normalized = normalizeSettings(settings);
    const targetPath = settingsPath(env);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, targetPath);
    return normalized;
}

await runToolSafe(async (input) => ({
    ok: true,
    settings: await writeSettings(input, process.env),
}));
