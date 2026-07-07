import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_SEARXNG_SETTINGS = Object.freeze({
    categories: 'general,scientific_publications',
    language: 'en',
    timeRange: '',
    safeSearch: 1,
    page: 1,
});

const VALID_TIME_RANGES = new Set(['', 'day', 'month', 'year']);

export function searxngDir(env = process.env) {
    const homePath = String(env.HOME || '').trim();
    if (!homePath) {
        throw new Error('HOME is required for SearXNG settings.');
    }
    return path.join(homePath, 'searxng');
}

export function searxngSettingsJsonPath(env = process.env) {
    return path.join(searxngDir(env), 'settings.json');
}

export function searxngSettingsYamlPath(env = process.env) {
    return path.join(searxngDir(env), 'settings.yml');
}

export function searxngSecretPath(env = process.env) {
    return path.join(searxngDir(env), 'secret_key');
}

export function normalizeSearxngSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const timeRange = normalizeTimeRange(input.timeRange, DEFAULT_SEARXNG_SETTINGS.timeRange);
    return {
        categories: normalizeCategories(input.categories, DEFAULT_SEARXNG_SETTINGS.categories),
        language: normalizeLanguage(input.language, DEFAULT_SEARXNG_SETTINGS.language),
        timeRange,
        safeSearch: normalizeInteger(input.safeSearch, DEFAULT_SEARXNG_SETTINGS.safeSearch, 0, 2),
        page: normalizeInteger(input.page, DEFAULT_SEARXNG_SETTINGS.page, 1, 10),
    };
}

export function normalizeSearxngSearchOptions(value = {}, defaults = DEFAULT_SEARXNG_SETTINGS) {
    const base = normalizeSearxngSettings(defaults);
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        categories: normalizeCategories(input.categories, base.categories),
        language: normalizeLanguage(input.language, base.language),
        timeRange: normalizeTimeRange(input.timeRange, base.timeRange),
        safeSearch: normalizeInteger(input.safeSearch, base.safeSearch, 0, 2),
        page: normalizeInteger(input.page, base.page, 1, 10),
    };
}

export async function readSearxngSettings(env = process.env) {
    try {
        const raw = await fs.readFile(searxngSettingsJsonPath(env), 'utf8');
        return normalizeSearxngSettings(JSON.parse(raw));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return normalizeSearxngSettings();
        }
        throw error;
    }
}

export async function writeSearxngSettings(settings, env = process.env) {
    const normalized = normalizeSearxngSettings(settings);
    const dir = searxngDir(env);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonFile(searxngSettingsJsonPath(env), normalized);
    await ensureSearxngSecret(env);
    await writeSearxngYaml(normalized, env);
    return normalized;
}

export async function ensureSearxngConfig(env = process.env) {
    const dir = searxngDir(env);
    await fs.mkdir(dir, { recursive: true });
    await ensureSearxngSecret(env);
    const settings = await readSearxngSettings(env);
    if (!await fileExists(searxngSettingsJsonPath(env))) {
        await writeJsonFile(searxngSettingsJsonPath(env), settings);
    }
    await writeSearxngYaml(settings, env);
    return settings;
}

async function writeSearxngYaml(settings, env = process.env) {
    const secret = await readSearxngSecret(env);
    const yaml = renderSearxngYaml(settings, secret);
    await fs.writeFile(searxngSettingsYamlPath(env), yaml);
}

function renderSearxngYaml(settings, secret) {
    const normalized = normalizeSearxngSettings(settings);
    return `use_default_settings: true

search:
  formats:
    - html
    - json
  safe_search: ${normalized.safeSearch}
  default_lang: ${quoteYaml(normalized.language)}
  max_page: ${normalized.page}

server:
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  secret_key: ${quoteYaml(secret)}
`;
}

async function ensureSearxngSecret(env = process.env) {
    const targetPath = searxngSecretPath(env);
    if (await fileExists(targetPath)) return;
    const secret = randomBytes(32).toString('base64');
    await fs.writeFile(targetPath, `${secret}\n`, { mode: 0o600 });
}

async function readSearxngSecret(env = process.env) {
    await ensureSearxngSecret(env);
    return (await fs.readFile(searxngSecretPath(env), 'utf8')).trim();
}

async function writeJsonFile(targetPath, value) {
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempPath, targetPath);
}

async function fileExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function normalizeCategories(value, fallback) {
    const raw = typeof value === 'string' ? value : '';
    const categories = raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^[a-z0-9_-]+$/.test(item));
    return categories.length ? [...new Set(categories)].join(',') : fallback;
}

function normalizeLanguage(value, fallback) {
    const raw = typeof value === 'string' ? value.trim() : '';
    return /^[a-zA-Z]{2,3}(-[a-zA-Z]{2})?$/.test(raw) ? raw : fallback;
}

function normalizeTimeRange(value, fallback) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return VALID_TIME_RANGES.has(raw) ? raw : fallback;
}

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function quoteYaml(value) {
    return JSON.stringify(String(value ?? ''));
}
