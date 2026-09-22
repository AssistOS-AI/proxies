#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.join(FIXTURE_DIR, 'events');
const FAKE_VERSION = '1.18.31';
// Names the POSIX sh wrapper (PWD, OLDPWD, SHLVL, _) and macOS
// (__CF_USER_TEXT_ENCODING) add on their own; the runner never passes them.
const PLATFORM_ADDED_ENV = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
        process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
    });
}

function processGroupId() {
    try {
        return Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    } catch {
        return undefined;
    }
}

function recordCall(stdin) {
    const logFile = process.env.FAKE_OPENCODE_CALL_LOG;
    if (!logFile) return;
    const envKeys = Object.keys(process.env)
        .filter((name) => !name.startsWith('FAKE_OPENCODE_') && !PLATFORM_ADDED_ENV.has(name))
        .sort();
    const entry = {
        argv: process.argv.slice(2),
        envKeys,
        cwd: process.cwd(),
        stdinBytes: stdin.length,
        stdinSha256: crypto.createHash('sha256').update(stdin).digest('hex'),
        pid: process.pid,
    };
    const pgid = processGroupId();
    if (Number.isInteger(pgid)) entry.pgid = pgid;
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function resolveEventsFile(name) {
    if (path.isAbsolute(name)) return name;
    const withExt = name.endsWith('.jsonl') ? name : `${name}.jsonl`;
    return path.join(EVENTS_DIR, withExt);
}

function replay(spec) {
    let name = spec;
    let exitCode = 0;
    const match = /:exit=(\d+)$/.exec(spec);
    if (match) {
        exitCode = Number(match[1]);
        name = spec.slice(0, match.index);
    }
    const text = fs.readFileSync(resolveEventsFile(name), 'utf8');
    process.stdout.write(text.endsWith('\n') || !text ? text : `${text}\n`, () => process.exit(exitCode));
}

function hangForever() {
    setInterval(() => {}, 60000);
}

async function main() {
    const mode = process.env.FAKE_OPENCODE_MODE || '';
    if (mode === 'version' || process.argv[2] === '--version') {
        process.stdout.write(`${FAKE_VERSION}\n`);
        return;
    }
    const stdin = await readStdin();
    recordCall(stdin);
    if (mode.startsWith('replay:')) {
        replay(mode.slice('replay:'.length));
        return;
    }
    if (mode.startsWith('slow:')) {
        const rest = mode.slice('slow:'.length);
        const separator = rest.indexOf(':');
        const delay = Number(rest.slice(0, separator));
        setTimeout(() => replay(rest.slice(separator + 1)), delay);
        return;
    }
    if (mode.startsWith('exit:')) {
        process.stderr.write('fake opencode: failing on purpose\n');
        process.exit(Number(mode.slice('exit:'.length)));
    }
    if (mode === 'hang') {
        hangForever();
        return;
    }
    if (mode === 'grandchild-ignores-term') {
        process.on('SIGTERM', () => {});
        spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 300'], { stdio: 'inherit' });
        hangForever();
        return;
    }
    process.stderr.write(`fake opencode: unknown FAKE_OPENCODE_MODE ${JSON.stringify(mode)}\n`);
    process.exit(2);
}

main();
