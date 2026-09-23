import { MESSAGE_MAX_CHARS } from './constants.mjs';

const MAX_RETRY_AFTER_SECONDS = 86400;
const MODEL_WORD_RE = /model/i;
const MODEL_MISSING_RE = /not found|does not exist|unknown model|invalid model/i;
const PERMISSION_LINE_RE = /permission requested: ([A-Za-z0-9_.:-]+)[^\n]*; auto-rejecting/;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function parseEventLines(text) {
    const events = [];
    for (const line of String(text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
        } catch {
            // Non-JSON lines are not events.
        }
    }
    return events;
}

function clampMessage(message) {
    const text = String(message ?? '');
    return text.length > MESSAGE_MAX_CHARS ? text.slice(0, MESSAGE_MAX_CHARS) : text;
}

function failure(status, type, message, stateEffect = null, extra = {}) {
    return { ok: false, status, type, message: clampMessage(message), ...extra, stateEffect };
}

function isValidCost(cost) {
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
}

function headerValue(headers, name) {
    if (!headers || typeof headers !== 'object') return undefined;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

export function parseRetryAfter(value, now = Date.now()) {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const trimmed = value.trim();
    let seconds;
    if (/^\d+$/.test(trimmed)) {
        seconds = Number(trimmed);
    } else if (/[A-Za-z]/.test(trimmed)) {
        const at = Date.parse(trimmed);
        if (!Number.isFinite(at)) return undefined;
        seconds = Math.ceil((at - now) / 1000);
    } else {
        return undefined;
    }
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}

function responseBodyText(data) {
    const body = data?.responseBody;
    if (typeof body === 'string') return body;
    if (body === undefined || body === null) return '';
    try {
        return JSON.stringify(body);
    } catch {
        return '';
    }
}

function isModelNotFound(statusCode, body) {
    if (statusCode === 404) return true;
    return statusCode === 400 && MODEL_WORD_RE.test(body) && MODEL_MISSING_RE.test(body);
}

function classifyErrorEvent(event, now) {
    const data = event?.error?.data && typeof event.error.data === 'object' ? event.error.data : {};
    const statusCode = Number.isInteger(data.statusCode) ? data.statusCode : null;
    const body = responseBodyText(data);
    if (statusCode === 401 || statusCode === 403) {
        if (body.includes('FreeTierError')) {
            return failure(403, 'free_tier_refused', `OpenCode free tier refused the request (upstream HTTP ${statusCode})`, 'refused');
        }
        return failure(403, 'credential_rejected', `OpenCode rejected the credential (upstream HTTP ${statusCode})`, 'refused');
    }
    if (statusCode === 429) {
        const retryAfter = parseRetryAfter(headerValue(data.responseHeaders, 'retry-after'), now);
        const extra = retryAfter === undefined ? {} : { retryAfter };
        return failure(429, 'rate_limit_error', 'OpenCode free tier rate limit reached (upstream HTTP 429)', null, extra);
    }
    if (isModelNotFound(statusCode, body)) {
        return failure(404, 'model_not_found', `OpenCode does not serve this model (upstream HTTP ${statusCode})`, 'disable-model');
    }
    const name = typeof event?.error?.name === 'string' ? event.error.name.slice(0, 80) : 'error';
    const status = statusCode === null ? 'no status' : `upstream HTTP ${statusCode}`;
    return failure(502, 'upstream_error', `OpenCode CLI reported ${name} (${status})`);
}

function mapUsage(stepFinishes) {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    for (const event of stepFinishes) {
        const tokens = event?.part?.tokens || {};
        const cache = tokens.cache || {};
        const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
        prompt += num(tokens.input) + num(cache.read) + num(cache.write);
        completion += num(tokens.output) + num(tokens.reasoning);
        total += num(tokens.total);
    }
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export function evaluateRun({ events = [], exitCode = 0, killed = false, now = Date.now() } = {}) {
    const list = Array.isArray(events) ? events : [];
    const toolUses = list.filter((event) => event?.type === 'tool_use');
    const stepFinishes = list.filter((event) => event?.type === 'step_finish');
    const errorEvent = list.find((event) => event?.type === 'error');
    const textEvents = list.filter((event) => event?.type === 'text');

    if (toolUses.some((event) => event?.part?.state?.status === 'completed')) {
        return failure(502, 'confinement_rejected', 'confinement guard: the CLI reported a completed tool call', 'tripped');
    }
    if (stepFinishes.some((event) => !isValidCost(event?.part?.cost) || Number(event.part.cost) > 0)) {
        return failure(502, 'confinement_rejected', 'confinement guard: the CLI reported a non-zero or invalid cost', 'tripped');
    }
    if (errorEvent) return classifyErrorEvent(errorEvent, now);
    if (killed) return failure(504, 'deadline_exceeded', 'the OpenCode CLI did not finish before the deadline');
    if (toolUses.length > 0) {
        return failure(502, 'confinement_rejected', 'confinement guard: the model attempted a tool call');
    }
    const badFinish = stepFinishes.find((event) => !['stop', 'length'].includes(event?.part?.reason));
    if (badFinish) {
        const reason = String(badFinish?.part?.reason ?? 'missing').slice(0, 40);
        return failure(502, 'confinement_rejected', `confinement guard: unexpected finish reason ${reason}`);
    }
    if (exitCode !== 0) {
        return failure(502, 'cli_failed', `the OpenCode CLI exited with code ${exitCode === null ? 'null' : exitCode}`);
    }
    const text = textEvents
        .map((event) => (typeof event?.part?.text === 'string' ? event.part.text : ''))
        .join('');
    if (!text.trim()) return failure(502, 'empty_answer', 'the OpenCode CLI returned no answer text');
    if (stepFinishes.length === 0) {
        return failure(502, 'confinement_rejected', 'confinement guard: the CLI reported no finished step');
    }
    const finishReason = stepFinishes[stepFinishes.length - 1].part.reason;
    return { ok: true, text, finishReason, usage: mapUsage(stepFinishes) };
}

export function confinementLogLines(stderr) {
    const lines = [];
    for (const rawLine of String(stderr ?? '').split('\n')) {
        const match = PERMISSION_LINE_RE.exec(rawLine.replace(ANSI_RE, ''));
        if (match) lines.push(`[opencode-free] confinement: rejected ${match[1]}`);
    }
    return lines;
}
