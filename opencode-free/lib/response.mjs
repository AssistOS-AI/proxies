import crypto from 'node:crypto';

import { MESSAGE_MAX_CHARS } from './constants.mjs';

const ERROR_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 22;

export function newCompletionId() {
    const bytes = crypto.randomBytes(ID_LENGTH);
    let suffix = '';
    for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
    return `chatcmpl-ocf-${suffix}`;
}

function unixSeconds() {
    return Math.floor(Date.now() / 1000);
}

function normalizeUsage(usage) {
    const value = (name) => (Number.isFinite(Number(usage?.[name])) ? Number(usage[name]) : 0);
    return {
        prompt_tokens: value('prompt_tokens'),
        completion_tokens: value('completion_tokens'),
        total_tokens: value('total_tokens'),
    };
}

export function buildCompletion({ id, model, text, finishReason, usage, created } = {}) {
    return {
        id: id || newCompletionId(),
        object: 'chat.completion',
        created: Number.isInteger(created) ? created : unixSeconds(),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: typeof text === 'string' ? text : '',
                },
                finish_reason: finishReason === 'length' ? 'length' : 'stop',
            },
        ],
        usage: normalizeUsage(usage),
    };
}

function sseEvent(data) {
    return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function sseFrames(completion) {
    const choice = completion?.choices?.[0] || {};
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    const base = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
    };
    return [
        sseEvent({
            ...base,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }),
        sseEvent({
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }),
        sseEvent({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
            usage: normalizeUsage(completion.usage),
        }),
        sseEvent('[DONE]'),
    ];
}

export function writeSseCompletion(out, completion) {
    for (const frame of sseFrames(completion)) out.write(frame);
}

export function buildEnvelope({ status, type, message, retryAfter } = {}) {
    const safeType = typeof type === 'string' && ERROR_TYPE_RE.test(type) ? type : 'upstream_error';
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
    const text = String(message ?? '');
    const envelope = {
        ok: false,
        error: safeType,
        message: text.length > MESSAGE_MAX_CHARS ? text.slice(0, MESSAGE_MAX_CHARS) : text,
        status: safeStatus,
        type: safeType,
    };
    if (Number.isFinite(retryAfter) && retryAfter > 0) envelope.retryAfter = Math.ceil(retryAfter);
    return envelope;
}

export function writeEnvelope({ out, err, stream, status, type, message, retryAfter } = {}) {
    const line = `${JSON.stringify(buildEnvelope({ status, type, message, retryAfter }))}\n`;
    if (stream === true) err.write(line);
    else out.write(line);
    return line;
}

export function startKeepalive(out, intervalMs) {
    const timer = setInterval(() => {
        out.write(': keepalive\n\n');
    }, intervalMs);
    timer.unref?.();
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    };
}
