import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000,
});

export function settingsPath(env = process.env) {
    const homePath = String(env.HOME || '').trim();
    if (!homePath) {
        throw new Error('HOME is required for SearchAgent settings.');
    }
    return path.join(homePath, 'search-agent-settings.json');
}

export function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

export function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        maxResults: normalizeInteger(input.maxResults, DEFAULT_SETTINGS.maxResults, 1, 100),
        maxQueryChars: normalizeInteger(input.maxQueryChars, DEFAULT_SETTINGS.maxQueryChars, 1, 20000),
    };
}

export async function readSettings(env = process.env) {
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

export async function writeSettings(settings, env = process.env) {
    const normalized = normalizeSettings(settings);
    const targetPath = settingsPath(env);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, targetPath);
    return normalized;
}
