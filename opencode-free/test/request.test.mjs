import assert from 'node:assert/strict';
import test from 'node:test';

import { PROMPT_MAX_BYTES } from '../lib/constants.mjs';
import { extractOpenAiRequest, flattenMessages, validateChatRequest } from '../lib/request.mjs';

const NUL = String.fromCharCode(0);
const ZWSP = String.fromCodePoint(0x200b);
const WAVE = String.fromCodePoint(0x1f30a);
const Z_DOT = String.fromCodePoint(0x017c);

function chat(overrides = {}) {
    return {
        model: 'big-pickle',
        messages: [{ role: 'user', content: 'Describe the sky in one sentence.' }],
        ...overrides,
    };
}

function rejected(request, pattern) {
    const result = validateChatRequest(request);
    assert.equal(result.ok, false, `expected a rejection for ${String(JSON.stringify(request)).slice(0, 120)}`);
    if (pattern) assert.match(result.message, pattern);
    return result;
}

function accepted(request) {
    const result = validateChatRequest(request);
    assert.equal(result.ok, true, result.message);
    return result;
}

test('accepts a minimal request and returns the bare model id', () => {
    const result = accepted(chat());
    assert.deepEqual(result, {
        ok: true,
        model: 'big-pickle',
        prompt: 'User: Describe the sky in one sentence.',
        stream: false,
    });
    assert.equal(accepted(chat({ model: 'opencode/nemotron-3-ultra-free' })).model, 'nemotron-3-ultra-free');
});

test('stream is strictly request.stream === true', () => {
    assert.equal(accepted(chat({ stream: true })).stream, true);
    assert.equal(accepted(chat({ stream: 'true' })).stream, false);
    assert.equal(accepted(chat({ stream: 1 })).stream, false);
});

test('rejects a missing or non-object request and bad models', () => {
    rejected(undefined, /request/);
    rejected(null, /request/);
    rejected([], /request/);
    rejected('text', /request/);
    rejected(chat({ model: undefined }), /model/);
    rejected(chat({ model: 42 }), /model/);
    rejected(chat({ model: 'opencode/does-not-exist' }), /model/);
    rejected(chat({ model: 'gpt-4o' }), /model/);
    rejected(chat({ model: `big-pickle${NUL}` }), /model/);
    rejected(chat({ model: 'opencode/opencode/big-pickle' }), /model/);
});

test('rejects empty messages, system-only and a trailing assistant turn', () => {
    rejected(chat({ messages: [] }), /messages/);
    rejected(chat({ messages: undefined }), /messages/);
    rejected(chat({ messages: 'hi' }), /messages/);
    rejected(chat({ messages: [{ role: 'system', content: 'Be terse.' }] }), /last message/);
    rejected(chat({
        messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
        ],
    }), /last message/);
    rejected(chat({ messages: [{ role: 'user', content: '   \n ' }] }), /empty/);
});

test('rejects unsupported roles and tool history fields', () => {
    for (const role of ['tool', 'function', 'developer', undefined]) {
        rejected(chat({ messages: [{ role, content: 'x' }, { role: 'user', content: 'y' }] }), /role/);
    }
    rejected(chat({
        messages: [
            { role: 'assistant', content: 'x', tool_calls: [{ id: 'a' }] },
            { role: 'user', content: 'y' },
        ],
    }), /tool_calls/);
    rejected(chat({
        messages: [
            { role: 'assistant', content: 'x', function_call: { name: 'f' } },
            { role: 'user', content: 'y' },
        ],
    }), /function_call/);
    rejected(chat({ messages: [{ role: 'user', content: 'y', tool_call_id: 'a' }] }), /tool_call_id/);
});

test('rejects non-text content parts and unknown content shapes', () => {
    for (const type of ['image_url', 'input_audio', 'file']) {
        rejected(chat({ messages: [{ role: 'user', content: [{ type, [type]: {} }] }] }), /type/);
    }
    rejected(chat({ messages: [{ role: 'user', content: 42 }] }), /content/);
    rejected(chat({ messages: [{ role: 'user', content: null }] }), /content/);
    rejected(chat({ messages: [{ role: 'user', content: ['bare string part'] }] }), /content/);
    assert.equal(
        accepted(chat({ messages: [{ role: 'user', content: { text: 'object text' } }] })).prompt,
        'User: object text',
    );
});

test('rejects tools, tool_choice, functions, response_format and n', () => {
    rejected(chat({ tools: [{ type: 'function', function: { name: 'f' } }] }), /tools/);
    rejected(chat({ tools: {} }), /tools/);
    rejected(chat({ tool_choice: 'auto' }), /tool_choice/);
    rejected(chat({ tool_choice: { type: 'function', function: { name: 'f' } } }), /tool_choice/);
    rejected(chat({ functions: [{ name: 'f' }] }), /functions/);
    rejected(chat({ function_call: 'auto' }), /function_call/);
    rejected(chat({ response_format: { type: 'json_object' } }), /response_format/);
    rejected(chat({ response_format: { type: 'json_schema', json_schema: {} } }), /response_format/);
    for (const n of [0, -1, 1.5, '1', 2]) rejected(chat({ n }), /\bn\b/);
    accepted(chat({ n: 1 }));
});

test('accepts and ignores documented sampling and bookkeeping fields', () => {
    const result = accepted(chat({
        max_tokens: 2147483647,
        max_completion_tokens: 10,
        temperature: -5,
        top_p: 3,
        stop: ['x'],
        seed: 1,
        presence_penalty: 9,
        frequency_penalty: -9,
        logit_bias: { 1: 2 },
        logprobs: true,
        user: 'someone',
        metadata: { a: 'b' },
        stream_options: { include_usage: true },
        tools: [],
        tool_choice: 'none',
        parallel_tool_calls: false,
        response_format: { type: 'text' },
    }));
    assert.equal(result.prompt, 'User: Describe the sky in one sentence.');
});

test('rejects a NUL byte in any text', () => {
    rejected(chat({ messages: [{ role: 'user', content: `a${NUL}b` }] }), /NUL/);
    rejected(chat({ messages: [{ role: 'user', content: [{ type: 'text', text: `a${NUL}` }] }] }), /NUL/);
    rejected(chat({
        messages: [{ role: 'system', content: `s${NUL}` }, { role: 'user', content: 'u' }],
    }), /NUL/);
});

test('flattens with the exact template', () => {
    const prompt = flattenMessages([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'there' }] },
        { role: 'system', content: 'Answer in English.' },
        { role: 'user', content: 'What is 2+2?' },
    ]);
    assert.equal(prompt, [
        'System instructions:',
        'Be terse.',
        '',
        'Answer in English.',
        '',
        'User: Hi',
        '',
        'Assistant: Hello\nthere',
        '',
        'User: What is 2+2?',
    ].join('\n'));
    assert.equal(flattenMessages([{ role: 'user', content: 'Only' }]), 'User: Only');
});

test('prompt cap: exactly 65536 bytes accepted, 65537 rejected', () => {
    const base = flattenMessages([{ role: 'user', content: 'x' }]);
    const filler = 'x'.repeat(PROMPT_MAX_BYTES - Buffer.byteLength(base, 'utf8') + 1);
    const exact = [{ role: 'user', content: filler }];
    assert.equal(Buffer.byteLength(flattenMessages(exact), 'utf8'), 65536);
    const ok = accepted(chat({ messages: exact }));
    assert.equal(Buffer.byteLength(ok.prompt, 'utf8'), 65536);
    const over = [{ role: 'user', content: `${filler}x` }];
    assert.equal(Buffer.byteLength(flattenMessages(over), 'utf8'), 65537);
    const result = rejected(chat({ messages: over }));
    assert.equal(result.message, 'prompt exceeds 65536 bytes');
});

test('multibyte text counts UTF-8 bytes and round-trips unchanged', () => {
    const text = `Za${Z_DOT}ółć gęślą jaźń ${WAVE}${ZWSP}!`;
    const result = accepted(chat({ messages: [{ role: 'user', content: text }] }));
    assert.equal(result.prompt, `User: ${text}`);
    assert.ok(result.prompt.includes(ZWSP));
    assert.ok(result.prompt.includes(WAVE));
});

test('10000 short turns flatten in under 200 ms; under the cap they are accepted', () => {
    // Every user or assistant turn costs at least 9 bytes, so 10000 of them
    // cannot stay under the cap; single-character system turns cost 3 bytes.
    const underCap = [];
    for (let index = 0; index < 9999; index += 1) underCap.push({ role: 'system', content: 'k' });
    underCap.push({ role: 'user', content: 'end' });
    const conversation = [];
    for (let index = 0; index < 9999; index += 1) {
        conversation.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'k' });
    }
    conversation.push({ role: 'user', content: 'end' });
    for (const messages of [underCap, conversation]) {
        assert.equal(messages.length, 10000);
        const started = process.hrtime.bigint();
        flattenMessages(messages);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        assert.ok(elapsedMs < 200, `flattenMessages took ${elapsedMs} ms`);
    }
    assert.ok(Buffer.byteLength(flattenMessages(underCap), 'utf8') <= PROMPT_MAX_BYTES);
    accepted(chat({ messages: underCap }));
    assert.equal(rejected(chat({ messages: conversation })).message, 'prompt exceeds 65536 bytes');
});

test('extractOpenAiRequest accepts { request } and the harness wrapper', () => {
    const request = chat();
    assert.equal(extractOpenAiRequest({ endpoint: 'openai.chat.completions', request }), request);
    assert.equal(extractOpenAiRequest({ input: { request } }), request);
    assert.equal(extractOpenAiRequest({}), null);
    assert.equal(extractOpenAiRequest(null), null);
    assert.equal(extractOpenAiRequest({ request: 'x' }), null);
});
