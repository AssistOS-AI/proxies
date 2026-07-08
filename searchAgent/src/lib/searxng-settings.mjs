import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function searxngDir(env = process.env) {
    const homePath = String(env.HOME || '').trim();
    if (!homePath) {
        throw new Error('HOME is required for SearXNG settings.');
    }
    return path.join(homePath, 'searxng');
}

export function searxngSettingsYamlPath(env = process.env) {
    return path.join(searxngDir(env), 'settings.yml');
}

export function searxngSecretPath(env = process.env) {
    return path.join(searxngDir(env), 'secret_key');
}

export async function ensureSearxngConfig(env = process.env) {
    const dir = searxngDir(env);
    await fs.mkdir(dir, { recursive: true });
    await ensureSearxngSecret(env);
    await writeSearxngYaml(env);
    return { settingsPath: searxngSettingsYamlPath(env) };
}

async function writeSearxngYaml(env = process.env) {
    const secret = await readSearxngSecret(env);
    const yaml = renderSearxngYaml(secret);
    await fs.writeFile(searxngSettingsYamlPath(env), yaml);
}

function renderSearxngYaml(secret) {
    return `use_default_settings: true

search:
  formats:
    - html
    - json

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

async function fileExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function quoteYaml(value) {
    return JSON.stringify(String(value ?? ''));
}
