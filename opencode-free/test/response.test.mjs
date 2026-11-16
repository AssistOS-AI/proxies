import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCompletion,
    newCompletionId,
    sseFrames,
    startKeepalive,
    writeEnvelope,
    writeSseCompletion,
} from '../lib/response.mjs';

const SKY = 'The sky is a soft, hazy blue today, edged with faint silver clouds.';
const USAGE = { prompt_tokens: 6241, completion_tokens: 19, total_tokens: 6260 };

function sink() {
    const chunks = [];
    return {
        chunks,
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        text() {
            return chunks.join('');
        },
    };
}

function dataPayloads(raw) {
    return raw.split('\n\n').filter(Boolean).map((event) => {
        assert.ok(event.startsWith('data: '), `unexpected SSE event ${JSON.stringify(event)}`);
        return event.slice('data: '.length);
    });
}

test('newCompletionId has the chatcmpl-ocf- prefix and 22 base36 chars', () => {
    const ids = new Set();
    for (let index = 0; index < 50; index += 1) {
        const id = newCompletionId();
        assert.match(id, /^chatcmpl-ocf-[0-9a-z]{22}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 50);
});

test('buildCompletion produces a buffered chat.completion', () => {
    const completion = buildCompletion({ id: 'chatcmpl-ocf-x', model: 'big-pickle', text: SKY, finishReason: 'stop', usage: USAGE });
    assert.equal(completion.id, 'chatcmpl-ocf-x');
    assert.equal(completion.object, 'chat.completion');
    assert.ok(Number.isInteger(completion.created));
    assert.equal(completion.model, 'big-pickle');
    assert.deepEqual(completion.choices, [
        { index: 0, message: { role: 'assistant', content: SKY }, finish_reason: 'stop' },
    ]);
    assert.deepEqual(completion.usage, USAGE);
    assert.equal(buildCompletion({ model: 'big-pickle', text: 'x', finishReason: 'length', usage: USAGE }).choices[0].finish_reason, 'length');
});

test('sseFrames yields exactly the role, content, finish and DONE frames', () => {
    const completion = buildCompletion({ model: 'big-pickle', text: SKY, finishReason: 'stop', usage: USAGE });
    const frames = sseFrames(completion);
    assert.equal(frames.length, 4);
    for (const frame of frames) assert.match(frame, /^data: .*\n\n$/s);
    assert.equal(frames[3], 'data: [DONE]\n\n');
    const [role, content, finish] = frames.slice(0, 3).map((frame) => JSON.parse(frame.slice(6)));
    for (const chunk of [role, content, finish]) {
        assert.equal(chunk.id, completion.id);
        assert.equal(chunk.object, 'chat.completion.chunk');
        assert.equal(chunk.created, completion.created);
        assert.equal(chunk.model, 'big-pickle');
    }
    assert.deepEqual(role.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    assert.deepEqual(content.choices, [{ index: 0, delta: { content: SKY }, finish_reason: null }]);
    assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
    assert.deepEqual(finish.usage, USAGE);
    assert.equal(Object.hasOwn(role, 'usage'), false);
    assert.equal(Object.hasOwn(content, 'usage'), false);
});

test('writeSseCompletion writes the frames and a data: [DONE] inside the text stays escaped', () => {
    const text = 'Line one\n\ndata: [DONE]\n\nLine two';
    const out = sink();
    writeSseCompletion(out, buildCompletion({ model: 'big-pickle', text, finishReason: 'stop', usage: USAGE }));
    const raw = out.text();
    const payloads = dataPayloads(raw);
    assert.equal(payloads.length, 4);
    assert.equal(JSON.parse(payloads[1]).choices[0].delta.content, text);
    const doneLines = raw.split('\n').filter((line) => line.includes('[DONE]'));
    assert.equal(doneLines.filter((line) => line === 'data: [DONE]').length, 1);
    assert.ok(raw.endsWith('data: [DONE]\n\n'));
    assert.equal(raw.split('\n').filter((line) => line === 'data: [DONE]').length, 1);
});

test('the content frame round-trips Polish diacritics, an emoji and a zero-width space', () => {
    const text = `Za${String.fromCodePoint(0x017c)}ółć ${String.fromCodePoint(0x1f30a)}${String.fromCodePoint(0x200b)}!`;
    const frames = sseFrames(buildCompletion({ model: 'big-pickle', text, finishReason: 'stop', usage: USAGE }));
    assert.equal(JSON.parse(frames[1].slice(6)).choices[0].delta.content, text);
});

test('buffered writeEnvelope writes exactly one envelope line to stdout', () => {
    const out = sink();
    const err = sink();
    writeEnvelope({ out, err, stream: false, status: 400, type: 'invalid_request_error', message: 'tools are not supported' });
    assert.equal(err.text(), '');
    assert.equal(out.text(), '{"ok":false,"error":"invalid_request_error","message":"tools are not supported","status":400,"type":"invalid_request_error"}\n');
});

test('streamed writeEnvelope writes nothing to stdout and one LF-terminated line to stderr', () => {
    const out = sink();
    const err = sink();
    writeEnvelope({ out, err, stream: true, status: 429, type: 'rate_limit_error', message: 'busy', retryAfter: 10 });
    assert.equal(out.text(), '');
    const raw = err.text();
    assert.ok(raw.endsWith('}\n'));
    assert.equal(raw.indexOf('\n'), raw.length - 1);
    assert.deepEqual(JSON.parse(raw), {
        ok: false,
        error: 'rate_limit_error',
        message: 'busy',
        status: 429,
        type: 'rate_limit_error',
        retryAfter: 10,
    });
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['ok', 'error', 'message', 'status', 'type', 'retryAfter']);
});

test('writeEnvelope clamps the message and sanitizes type and status', () => {
    const out = sink();
    writeEnvelope({ out, err: sink(), stream: false, status: 200, type: 'Bad Type', message: 'x'.repeat(5000) });
    const envelope = JSON.parse(out.text());
    assert.equal(envelope.message.length, 1024);
    assert.equal(envelope.status, 502);
    assert.match(envelope.type, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(envelope.error, envelope.type);
    assert.equal(Object.hasOwn(envelope, 'retryAfter'), false);
});

test('startKeepalive writes comment frames until stopped', async () => {
    const out = sink();
    const stop = startKeepalive(out, 20);
    await new Promise((resolve) => setTimeout(resolve, 75));
    stop();
    const count = out.chunks.length;
    assert.ok(count >= 2, `expected at least 2 keepalives, got ${count}`);
    for (const chunk of out.chunks) assert.equal(chunk, ': keepalive\n\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(out.chunks.length, count);
    stop();
});
