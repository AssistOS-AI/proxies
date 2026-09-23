export const CLI_VERSION = '1.18.31';

export const CLI_TARBALL_SHA256 = Object.freeze({
    arm64: 'd4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6',
    amd64: 'e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4',
});

export const DEFAULT_CLI_PATH = '/opt/opencode/bin/opencode';
export const DEFAULT_CONFIG_DIR = '/opt/opencode-free/config';
export const DEFAULT_RUNTIME_DIR = '/var/tmp/opencode-free';
export const DEFAULT_STATE_FILE = '/data/service-state.json';
export const DEFAULT_CLI_DEADLINE_MS = 90000;
export const DEFAULT_SLOT_CAP = 2;
export const DEFAULT_SLOT_WAIT_MS = 20000;

export const SLOT_POLL_MS = 250;
export const KILL_GRACE_MS = 2000;
export const KEEPALIVE_INTERVAL_MS = 10000;
export const PROMPT_MAX_BYTES = 65536;
export const STDERR_CAPTURE_BYTES = 64 * 1024;
export const NON_JSON_LINE_LOG_CHARS = 200;
export const MESSAGE_MAX_CHARS = 1024;

export const RUN_SUBDIRS = Object.freeze(['home', 'data', 'state', 'cache', 'tmp', 'work']);

export const FORBIDDEN_CLI_FLAGS = Object.freeze([
    '--auto',
    '--share',
    '--continue',
    '-c',
    '--session',
    '-s',
    '--attach',
    '--interactive',
    '-i',
    '--fork',
    '--port',
    '--print-logs',
]);

function stringSetting(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveIntSetting(value, fallback) {
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return fallback;
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSettings(env = process.env) {
    const source = env || {};
    return {
        cliPath: stringSetting(source.OPENCODE_FREE_CLI_PATH, DEFAULT_CLI_PATH),
        configDir: stringSetting(source.OPENCODE_FREE_CONFIG_DIR, DEFAULT_CONFIG_DIR),
        runtimeDir: stringSetting(source.OPENCODE_FREE_RUNTIME_DIR, DEFAULT_RUNTIME_DIR),
        stateFile: stringSetting(source.OPENCODE_FREE_STATE_FILE, DEFAULT_STATE_FILE),
        deadlineMs: positiveIntSetting(source.OPENCODE_FREE_CLI_DEADLINE_MS, DEFAULT_CLI_DEADLINE_MS),
        slotCap: positiveIntSetting(source.OPENCODE_FREE_SLOT_CAP, DEFAULT_SLOT_CAP),
        slotWaitMs: positiveIntSetting(source.OPENCODE_FREE_SLOT_WAIT_MS, DEFAULT_SLOT_WAIT_MS),
    };
}
