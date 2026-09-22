import { CLI_VERSION } from './constants.mjs';

export const ALLOW_LIST_REVIEWED_FOR_CLI = '1.18.31';

export const ALLOW_LIST = Object.freeze([
    Object.freeze({ id: 'big-pickle', contextWindow: 200000, maxOutputTokens: 32000 }),
    Object.freeze({ id: 'ling-3.0-flash-fin-free', contextWindow: 262144, maxOutputTokens: 32768 }),
    Object.freeze({ id: 'mimo-v2.5-free', contextWindow: 200000, maxOutputTokens: 32000 }),
    Object.freeze({ id: 'muse-spark-1.2-contributor-free', contextWindow: 1048576, maxOutputTokens: 131072 }),
    Object.freeze({ id: 'muse-spark-1.3-contributor-free', contextWindow: 1048576, maxOutputTokens: 131072 }),
    Object.freeze({ id: 'nemotron-3-ultra-free', contextWindow: 1000000, maxOutputTokens: 128000 }),
    Object.freeze({ id: 'nemotron-3.5-lightning-free', contextWindow: 262144, maxOutputTokens: 262144 }),
]);

export const MODEL_TAGS = Object.freeze(['opencode-free', 'text-only', 'no-tools']);

export const DATA_USE_NOTICE = 'free-period data may be used to improve the model; see https://opencode.ai/docs/zen';

const PROVIDER_PREFIX = 'opencode/';

export function allowListEntry(id) {
    return ALLOW_LIST.find((entry) => entry.id === id) || null;
}

export function isAllowListed(id) {
    if (typeof id !== 'string' || id.includes('\u0000')) return null;
    const bare = id.startsWith(PROVIDER_PREFIX) ? id.slice(PROVIDER_PREFIX.length) : id;
    return allowListEntry(bare) ? bare : null;
}

export function modelRow(id, meta = {}) {
    const entry = allowListEntry(id);
    if (!entry) throw new Error(`model is not allow-listed: ${String(id).slice(0, 80)}`);
    const contextWindow = meta.contextWindow ?? entry.contextWindow;
    const maxOutputTokens = meta.maxOutputTokens ?? entry.maxOutputTokens;
    return {
        id: entry.id,
        object: 'model',
        owned_by: 'opencode-free',
        modelId: entry.id,
        providerModelId: entry.id,
        displayName: `OpenCode ${entry.id} (free)`,
        supportsTools: false,
        supports_tools: false,
        supportsVision: false,
        supports_vision: false,
        supportsStreaming: true,
        supports_streaming: true,
        contextWindow,
        context_window: contextWindow,
        maxOutputTokens,
        max_output_tokens: maxOutputTokens,
        isFree: true,
        pricingMode: 'free',
        pricing: { mode: 'free' },
        tags: [...MODEL_TAGS],
        capabilities: {
            supportsTools: false,
            supportsVision: false,
            supportsStreaming: true,
        },
        metadata: {
            source: 'opencode-cli',
            cliVersion: CLI_VERSION,
            serviceState: meta.serviceState || 'verified',
            dataUse: DATA_USE_NOTICE,
        },
    };
}

export function listModelRows(state) {
    if (!state || state.state !== 'verified') return [];
    const disabled = state.disabledModels && typeof state.disabledModels === 'object'
        ? state.disabledModels
        : {};
    return ALLOW_LIST
        .filter((entry) => !Object.hasOwn(disabled, entry.id))
        .map((entry) => modelRow(entry.id, { ...entry, serviceState: state.state }));
}
