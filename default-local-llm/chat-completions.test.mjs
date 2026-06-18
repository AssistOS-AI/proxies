// proxies/default-local-llm/chat-completions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandlerInput, proxyChatCompletion } from './chat-completions.mjs';

test('parseHandlerInput extracts request from the AgentServer payload', () => {
    const payload = JSON.stringify({ endpoint: 'openai.chat.completions', request: { messages: [{ role: 'user', content: 'hi' }] }, metadata: {} });
    const out = parseHandlerInput(payload);
    assert.deepEqual(out.request.messages, [{ role: 'user', content: 'hi' }]);
});

test('parseHandlerInput throws when messages are missing', () => {
    assert.throws(() => parseHandlerInput(JSON.stringify({ request: {} })), /messages/i);
});

test('proxyChatCompletion posts to llama-server and returns json', async () => {
    let seenUrl = null; let seenBody = null;
    const fetchImpl = async (url, opts) => {
        seenUrl = url; seenBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ id: 'chatcmpl-x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
    };
    const res = await proxyChatCompletion({ request: { messages: [{ role: 'user', content: 'q' }] }, baseUrl: 'http://127.0.0.1:8080', fetchImpl });
    assert.equal(seenUrl, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.deepEqual(seenBody.messages, [{ role: 'user', content: 'q' }]);
    assert.equal(res.status, 200);
    assert.equal(res.json.choices[0].message.content, 'ok');
});

test('proxyChatCompletion throws on non-2xx', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
    await assert.rejects(
        () => proxyChatCompletion({ request: { messages: [{ role: 'user', content: 'q' }] }, baseUrl: 'http://127.0.0.1:8080', fetchImpl }),
        /503/,
    );
});
