import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { config } from '../config.mjs';

export async function ensureDataDir() {
  await mkdir(config.dataDir, { recursive: true });
}

export async function readGithubToken() {
  try {
    const token = await readFile(config.tokenPath, 'utf8');
    return token.trim();
  } catch {
    return '';
  }
}

export async function writeGithubToken(token) {
  await ensureDataDir();
  await writeFile(config.tokenPath, token, 'utf8');
}
