#!/usr/bin/env node
import fs from 'node:fs';

const targetPath = process.argv[2];
const secretPath = '/etc/searxng/secret_key';

if (!targetPath) {
    throw new Error('settings.yml path is required.');
}

let text = fs.readFileSync(targetPath, 'utf8');
const secretKey = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8').trim() : '';

function replaceLine(pattern, replacement) {
    if (pattern.test(text)) {
        text = text.replace(pattern, replacement);
        return true;
    }
    return false;
}

function ensureSearchFormats() {
    const searchBlock = text.match(/^search:\n([\s\S]*?)(?=^[^\s#][^:\n]*:|(?![\s\S]))/m);
    if (!searchBlock) {
        text += '\nsearch:\n  formats:\n    - html\n    - json\n';
        return;
    }

    const block = searchBlock[0];
    const formatBlock = block.match(/^  formats:\n((?:    - .+\n)+)/m);
    if (!formatBlock) {
        const updated = block.replace(/^search:\n/, 'search:\n  formats:\n    - html\n    - json\n');
        text = text.replace(block, updated);
        return;
    }

    if (/^\s*-\s*json\s*$/m.test(formatBlock[1])) return;
    const updatedFormats = `${formatBlock[0]}    - json\n`;
    text = text.replace(formatBlock[0], updatedFormats);
}

function ensureServerValue(key, value) {
    const serverBlock = text.match(/^server:\n([\s\S]*?)(?=^[^\s#][^:\n]*:|(?![\s\S]))/m);
    const line = `  ${key}: ${value}\n`;
    if (!serverBlock) {
        text += `\nserver:\n${line}`;
        return;
    }

    const block = serverBlock[0];
    const pattern = new RegExp(`^  ${key}:.*\\n`, 'm');
    const updated = pattern.test(block) ? block.replace(pattern, line) : `${block}${line}`;
    text = text.replace(block, updated);
}

ensureSearchFormats();
ensureServerValue('bind_address', '"127.0.0.1"');
ensureServerValue('port', '8888');
if (secretKey) {
    ensureServerValue('secret_key', `"${secretKey.replace(/"/g, '')}"`);
}
replaceLine(/^  limiter:\s+true\s*$/m, '  limiter: false');

fs.writeFileSync(targetPath, text.endsWith('\n') ? text : `${text}\n`);
