import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

export function isBrowserPoolAvailable(env = process.env) {
    return !isDisabled(env) && Boolean(resolveExecutablePath(env)) && canResolvePuppeteerCore();
}

export function resolveExecutablePath(env = process.env) {
    const configured = typeof env.BROWSER_EXECUTABLE_PATH === 'string'
        ? env.BROWSER_EXECUTABLE_PATH.trim()
        : '';
    if (configured) return configured;
    for (const candidate of [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

export function canResolvePuppeteerCore() {
    try {
        require.resolve('puppeteer-core');
        return true;
    } catch {
        return false;
    }
}

export function isDisabled(env = process.env) {
    return String(env.GOOGLE_AI_MODE_DISABLED || '').trim() === '1'
        || String(env.BROWSER_POOL_SIZE || '').trim() === '0';
}
