import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    ALLOW_LIST,
    ALLOW_LIST_REVIEWED_FOR_CLI,
    isAllowListed,
    listModelRows,
    modelRow,
} from '../lib/allow-list.mjs';
import { CLI_VERSION } from '../lib/constants.mjs';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const EXPECTED = [
    ['big-pickle', 200000, 32000],
    ['ling-3.0-flash-fin-free', 262144, 32768],
    ['mimo-v2.5-free', 200000, 32000],
    ['muse-spark-1.2-contributor-free', 1048576, 131072],
    ['muse-spark-1.3-contributor-free', 1048576, 131072],
    ['nemotron-3-ultra-free', 1000000, 128000],
    ['nemotron-3.5-lightning-free', 262144, 262144],
];

test('the allow-list holds the seven reviewed ids in order with catalogue limits', () => {
    assert.ok(Object.isFrozen(ALLOW_LIST));
    assert.deepEqual(
        ALLOW_LIST.map((entry) => [entry.id, entry.contextWindow, entry.maxOutputTokens]),
        EXPECTED,
    );
    assert.equal(ALLOW_LIST_REVIEWED_FOR_CLI, CLI_VERSION);
    assert.equal(ALLOW_LIST_REVIEWED_FOR_CLI, '1.18.31');
});

test('the allow-list ids equal the ids listed in the agent-card description', () => {
    const description = MANIFEST.endpoints['agent-card'].description;
    const listed = /\(([^)]*)\)/.exec(description)[1].split(',').map((id) => id.trim());
    assert.deepEqual([...listed].sort(), ALLOW_LIST.map((entry) => entry.id).sort());
    assert.equal(listed.length, 7);
});

test('isAllowListed accepts bare and opencode/ ids only', () => {
    assert.equal(isAllowListed('big-pickle'), 'big-pickle');
    assert.equal(isAllowListed('opencode/mimo-v2.5-free'), 'mimo-v2.5-free');
    for (const bad of ['gpt-4o', 'opencode/does-not-exist', 'BIG-PICKLE', ' big-pickle', 'openai/big-pickle',
        `big-pickle${String.fromCharCode(0)}`, 42, null, undefined, {}, ['big-pickle']]) {
        assert.equal(isAllowListed(bad), null);
    }
});

test('modelRow produces the exact C3 row', () => {
    assert.deepEqual(modelRow('big-pickle', ALLOW_LIST[0]), {
        id: 'big-pickle',
        object: 'model',
        owned_by: 'opencode-free',
        modelId: 'big-pickle',
        providerModelId: 'big-pickle',
        displayName: 'OpenCode big-pickle (free)',
        supportsTools: false,
        supports_tools: false,
        supportsVision: false,
        supports_vision: false,
        supportsStreaming: true,
        supports_streaming: true,
        contextWindow: 200000,
        context_window: 200000,
        maxOutputTokens: 32000,
        max_output_tokens: 32000,
        isFree: true,
        pricingMode: 'free',
        pricing: { mode: 'free' },
        tags: ['opencode-free', 'text-only', 'no-tools'],
        capabilities: { supportsTools: false, supportsVision: false, supportsStreaming: true },
        metadata: {
            source: 'opencode-cli',
            cliVersion: '1.18.31',
            serviceState: 'verified',
            dataUse: 'free-period data may be used to improve the model; see https://opencode.ai/docs/zen',
        },
    });
    assert.throws(() => modelRow('gpt-4o'));
});

test('listModelRows returns rows only in state verified, minus disabled ids', () => {
    for (const state of ['unverified', 'unavailable', 'refused', 'tripped']) {
        assert.deepEqual(listModelRows({ state, disabledModels: {} }), []);
    }
    assert.deepEqual(listModelRows(null), []);
    const rows = listModelRows({ state: 'verified', disabledModels: {} });
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((row) => row.id), EXPECTED.map(([id]) => id));
    for (const row of rows) {
        assert.equal(row.supports_tools, false);
        assert.equal(row.supportsTools, false);
        assert.equal(row.context_window, row.contextWindow);
        assert.equal(row.max_output_tokens, row.maxOutputTokens);
    }
    const partial = listModelRows({
        state: 'verified',
        disabledModels: { 'mimo-v2.5-free': { since: '2026-09-22T00:00:00.000Z', reason: 'model_not_found' } },
    });
    assert.equal(partial.length, 6);
    assert.equal(partial.some((row) => row.id === 'mimo-v2.5-free'), false);
});
