import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { confinementLogLines, evaluateRun, parseEventLines, parseRetryAfter } from '../lib/events.mjs';

const EVENTS_DIR = fileURLToPath(new URL('./fixtures/events/', import.meta.url));
const SKY = 'The sky is a soft, hazy blue today, edged with faint silver clouds.';

function fixture(name) {
    return parseEventLines(fs.readFileSync(path.join(EVENTS_DIR, name), 'utf8'));
}

function evaluate(name, extra = {}) {
    return evaluateRun({ events: fixture(name), exitCode: 0, killed: false, stderr: '', ...extra });
}

function assertFailure(outcome, status, type, stateEffect = null) {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, status);
    assert.equal(outcome.type, type);
    assert.equal(outcome.stateEffect, stateEffect);
    assert.equal(Object.hasOwn(outcome, 'text'), false);
    assert.ok(outcome.message.length > 0 && outcome.message.length <= 1024);
}

function stopEvents() {
    return fixture('stop-big-pickle.jsonl');
}

test('recorded fixtures have the expected shapes', () => {
    assert.deepEqual(stopEvents().map((event) => event.type), ['step_start', 'text', 'step_finish']);
    assert.deepEqual(fixture('free-tier-403.jsonl').map((event) => event.type), ['error']);
    assert.deepEqual(
        fixture('tool-calls-rejected.jsonl').map((event) => event.type),
        ['step_start', 'tool_use', 'tool_use', 'text', 'step_finish'],
    );
    const raw = fs.readFileSync(path.join(EVENTS_DIR, 'tool-calls-rejected.jsonl'), 'utf8');
    assert.equal(raw.includes('/private/'), false);
    assert.equal(raw.includes('/Users/'), false);
    assert.ok(raw.includes('"filePath":"/work/pwned2.txt"'));
});

test('parseEventLines skips blank and non-JSON lines', () => {
    const events = parseEventLines('not json\n\n{"type":"text"}\n[1,2]\n{"type":"step_finish"}');
    assert.deepEqual(events, [{ type: 'text' }, { type: 'step_finish' }]);
});

test('row 12: success with text, finish reason and usage mapping', () => {
    const outcome = evaluate('stop-big-pickle.jsonl');
    assert.deepEqual(outcome, {
        ok: true,
        text: SKY,
        finishReason: 'stop',
        usage: { prompt_tokens: 6241, completion_tokens: 19, total_tokens: 6260 },
    });
});

test('row 12: two text events are concatenated in order', () => {
    const outcome = evaluate('two-text-events.jsonl');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, SKY);
});

test('row 12: finish reason length is kept', () => {
    const outcome = evaluate('finish-length.jsonl');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.finishReason, 'length');
    assert.deepEqual(outcome.usage, { prompt_tokens: 6241, completion_tokens: 32, total_tokens: 6273 });
});

test('usage adds cache and reasoning tokens', () => {
    const events = stopEvents();
    events[2].part.tokens = { total: 100, input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 35 } };
    const outcome = evaluateRun({ events, exitCode: 0 });
    assert.deepEqual(outcome.usage, { prompt_tokens: 75, completion_tokens: 25, total_tokens: 100 });
});

test('row 12: text containing data: [DONE] is returned verbatim', () => {
    const outcome = evaluate('done-inside-text.jsonl');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, 'Line one\n\ndata: [DONE]\n\nLine two');
});

test('row 1: a completed tool_use after valid text trips the service and returns no text', () => {
    const outcome = evaluate('tool-completed.jsonl');
    assertFailure(outcome, 502, 'confinement_rejected', 'tripped');
    assert.equal(outcome.message.includes(SKY), false);
});

test('row 1 wins over an error event and a deadline kill', () => {
    const events = [...fixture('tool-completed.jsonl'), ...fixture('free-tier-403.jsonl')];
    assertFailure(evaluateRun({ events, exitCode: 1, killed: true }), 502, 'confinement_rejected', 'tripped');
});

test('row 2: positive, string and other invalid costs trip the service', () => {
    assertFailure(evaluate('cost-positive.jsonl'), 502, 'confinement_rejected', 'tripped');
    assertFailure(evaluate('cost-string.jsonl'), 502, 'confinement_rejected', 'tripped');
    for (const cost of [Number.NaN, -1, Number.POSITIVE_INFINITY, null, undefined, '0.0']) {
        const events = stopEvents();
        events[2].part.cost = cost;
        assertFailure(evaluateRun({ events, exitCode: 0 }), 502, 'confinement_rejected', 'tripped');
    }
});

test('row 3: 403 with FreeTierError is free_tier_refused; without it credential_rejected', () => {
    assertFailure(evaluate('free-tier-403.jsonl', { exitCode: 1 }), 403, 'free_tier_refused', 'refused');
    const events = fixture('free-tier-403.jsonl');
    events[0].error.data.responseBody = '{"type":"error","error":{"type":"AuthError","message":"bad key"}}';
    assertFailure(evaluateRun({ events, exitCode: 1 }), 403, 'credential_rejected', 'refused');
    events[0].error.data.statusCode = 401;
    assertFailure(evaluateRun({ events, exitCode: 1 }), 403, 'credential_rejected', 'refused');
});

test('row 4: 429 carries retryAfter from the retry-after header', () => {
    const outcome = evaluate('rate-limit-429.jsonl', { exitCode: 1 });
    assertFailure(outcome, 429, 'rate_limit_error', null);
    assert.equal(outcome.retryAfter, 17);
    const events = fixture('rate-limit-429.jsonl');
    delete events[0].error.data.responseHeaders['retry-after'];
    assert.equal(Object.hasOwn(evaluateRun({ events, exitCode: 1 }), 'retryAfter'), false);
    events[0].error.data.responseHeaders['Retry-After'] = 'soon';
    assert.equal(Object.hasOwn(evaluateRun({ events, exitCode: 1 }), 'retryAfter'), false);
});

test('parseRetryAfter handles seconds, HTTP dates and clamping', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    assert.equal(parseRetryAfter('17', now), 17);
    assert.equal(parseRetryAfter('0', now), 1);
    assert.equal(parseRetryAfter('999999', now), 86400);
    assert.equal(parseRetryAfter('Tue, 22 Sep 2026 12:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Tue, 22 Sep 2026 11:00:00 GMT', now), 1);
    assert.equal(parseRetryAfter('-5', now), undefined);
    assert.equal(parseRetryAfter('abc', now), undefined);
    assert.equal(parseRetryAfter(undefined, now), undefined);
});

test('row 5: 404 and model-shaped 400 disable the model', () => {
    assertFailure(evaluate('model-not-found.jsonl', { exitCode: 1 }), 404, 'model_not_found', 'disable-model');
    const events = fixture('model-not-found.jsonl');
    events[0].error.data.statusCode = 400;
    events[0].error.data.responseBody = '{"error":{"message":"Unknown model: foo"}}';
    assertFailure(evaluateRun({ events, exitCode: 1 }), 404, 'model_not_found', 'disable-model');
    events[0].error.data.responseBody = '{"error":{"message":"messages must not be empty"}}';
    assertFailure(evaluateRun({ events, exitCode: 1 }), 502, 'upstream_error', null);
});

test('row 6: other upstream errors and errors without statusCode', () => {
    assertFailure(evaluate('error-500.jsonl', { exitCode: 1 }), 502, 'upstream_error', null);
    const events = fixture('error-500.jsonl');
    delete events[1].error.data.statusCode;
    assertFailure(evaluateRun({ events, exitCode: 1 }), 502, 'upstream_error', null);
});

test('rows 3-6: an error event with exit code 0 is still classified by the error event', () => {
    assertFailure(evaluate('error-exit0.jsonl', { exitCode: 0 }), 403, 'free_tier_refused', 'refused');
});

test('row 7: a deadline kill is deadline_exceeded', () => {
    const partial = stopEvents().slice(0, 2);
    assertFailure(evaluateRun({ events: partial, exitCode: null, killed: true }), 504, 'deadline_exceeded', null);
    assertFailure(evaluateRun({ events: [], exitCode: null, killed: true }), 504, 'deadline_exceeded', null);
});

test('row 8: rejected tool attempts are confinement_rejected without a state effect', () => {
    const outcome = evaluate('tool-calls-rejected.jsonl');
    assertFailure(outcome, 502, 'confinement_rejected', null);
    assert.equal(outcome.message.includes('pwned'), false);
});

test('row 9: a finish reason other than stop or length, or no step_finish', () => {
    const events = stopEvents();
    events[2].part.reason = 'tool-calls';
    assertFailure(evaluateRun({ events, exitCode: 0 }), 502, 'confinement_rejected', null);
    assertFailure(evaluateRun({ events: stopEvents().slice(0, 2), exitCode: 0 }), 502, 'confinement_rejected', null);
});

test('row 10: a non-zero exit without an error event is cli_failed', () => {
    assertFailure(evaluateRun({ events: [], exitCode: 3 }), 502, 'cli_failed', null);
    assertFailure(evaluateRun({ events: stopEvents(), exitCode: 3 }), 502, 'cli_failed', null);
    assertFailure(evaluateRun({ events: [], exitCode: null, killed: false }), 502, 'cli_failed', null);
});

test('row 11: no text, blank text or zero events with exit 0 is empty_answer', () => {
    assertFailure(evaluate('no-text.jsonl'), 502, 'empty_answer', null);
    const events = stopEvents();
    events[1].part.text = '   \n';
    assertFailure(evaluateRun({ events, exitCode: 0 }), 502, 'empty_answer', null);
    assertFailure(evaluateRun({ events: [], exitCode: 0 }), 502, 'empty_answer', null);
});

test('a non-JSON line before valid events still succeeds', () => {
    const outcome = evaluate('nonjson-then-stop.jsonl');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, SKY);
});

test('failure messages never include the answer text', () => {
    for (const name of ['tool-completed.jsonl', 'cost-positive.jsonl', 'cost-string.jsonl', 'tool-calls-rejected.jsonl']) {
        const outcome = evaluate(name);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.message.includes('sky'), false);
        assert.equal(outcome.message.includes('system override'), false);
    }
});

test('confinementLogLines keeps only the tool name', () => {
    const stderr = [
        '\u001b[93m\u001b[1m! \u001b[0mpermission requested: bash (id > pwned.txt, uname -a); auto-rejecting',
        '\u001b[93m\u001b[1m! \u001b[0mpermission requested: edit (work/pwned2.txt); auto-rejecting',
        'some other diagnostic line',
        'permission requested: webfetch (http://127.0.0.1:9/canary); auto-rejecting',
    ].join('\n');
    assert.deepEqual(confinementLogLines(stderr), [
        '[opencode-free] confinement: rejected bash',
        '[opencode-free] confinement: rejected edit',
        '[opencode-free] confinement: rejected webfetch',
    ]);
    assert.deepEqual(confinementLogLines(''), []);
});
