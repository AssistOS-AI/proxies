import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_SCRIPT = fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url));

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function makeFakeCli({ mode, callLog } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-fake-cli-'));
    const logFile = callLog || path.join(dir, 'calls.jsonl');
    const cliPath = path.join(dir, 'opencode');
    const script = [
        '#!/bin/sh',
        `FAKE_OPENCODE_MODE=${shellQuote(mode)} FAKE_OPENCODE_CALL_LOG=${shellQuote(logFile)} exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_SCRIPT)} "$@"`,
        '',
    ].join('\n');
    fs.writeFileSync(cliPath, script, { mode: 0o755 });
    return {
        cliPath,
        callLog: logFile,
        dir,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

export function readCallLog(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
