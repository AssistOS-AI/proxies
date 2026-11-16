import { isAllowListed } from './allow-list.mjs';
import { PROMPT_MAX_BYTES } from './constants.mjs';

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const FORBIDDEN_MESSAGE_KEYS = ['tool_calls', 'function_call', 'tool_call_id'];

class RequestError extends Error {}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPresent(value) {
    return value !== undefined && value !== null;
}

function textOfPart(part, where) {
    if (!isPlainObject(part)) throw new RequestError(`${where} must be a text content part`);
    if (part.type !== 'text') {
        throw new RequestError(`${where}.type must be "text" (got ${JSON.stringify(String(part.type)).slice(0, 40)})`);
    }
    if (typeof part.text !== 'string') throw new RequestError(`${where}.text must be a string`);
    return part.text;
}

function contentText(content, where) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part, index) => textOfPart(part, `${where}[${index}]`)).join('\n');
    }
    if (isPlainObject(content) && typeof content.text === 'string') {
        if (content.type !== undefined && content.type !== 'text') {
            throw new RequestError(`${where}.type must be "text"`);
        }
        return content.text;
    }
    throw new RequestError(`${where} must be a string, an array of text parts or { text }`);
}

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) throw new RequestError('messages must be a non-empty array');
    if (messages.length === 0) throw new RequestError('messages must be a non-empty array');
    return messages.map((message, index) => {
        const where = `messages[${index}]`;
        if (!isPlainObject(message)) throw new RequestError(`${where} must be an object`);
        if (!ALLOWED_ROLES.has(message.role)) {
            throw new RequestError(`${where}.role must be system, user or assistant`);
        }
        for (const key of FORBIDDEN_MESSAGE_KEYS) {
            if (isPresent(message[key])) throw new RequestError(`${where}.${key} is not supported`);
        }
        const text = contentText(message.content, `${where}.content`);
        if (text.includes('\u0000')) throw new RequestError(`${where}.content contains a NUL byte`);
        return { role: message.role, text };
    });
}

function renderFlattened(normalized) {
    const systemTexts = normalized.filter((message) => message.role === 'system').map((message) => message.text);
    const blocks = [];
    if (systemTexts.length > 0) {
        blocks.push(`System instructions:\n${systemTexts.join('\n\n')}`);
    }
    for (const message of normalized) {
        if (message.role === 'user') blocks.push(`User: ${message.text}`);
        else if (message.role === 'assistant') blocks.push(`Assistant: ${message.text}`);
    }
    return blocks.join('\n\n');
}

export function flattenMessages(messages) {
    return renderFlattened(normalizeMessages(messages));
}

function checkRequestOptions(request) {
    if (isPresent(request.tools)) {
        if (!Array.isArray(request.tools)) throw new RequestError('tools must be absent or an empty array');
        if (request.tools.length > 0) throw new RequestError('tools are not supported');
    }
    if (isPresent(request.tool_choice) && request.tool_choice !== 'none') {
        throw new RequestError('tool_choice must be absent or "none"');
    }
    if (isPresent(request.functions)) throw new RequestError('functions are not supported');
    if (isPresent(request.function_call)) throw new RequestError('function_call is not supported');
    if (isPresent(request.response_format)) {
        const format = request.response_format;
        if (!isPlainObject(format) || format.type !== 'text' || Object.keys(format).length !== 1) {
            throw new RequestError('response_format must be absent or { "type": "text" }');
        }
    }
    if (isPresent(request.n) && request.n !== 1) throw new RequestError('n must be 1');
}

export function validateChatRequest(request) {
    try {
        if (!isPlainObject(request)) throw new RequestError('request must be a JSON object');
        if (typeof request.model !== 'string' || !request.model) {
            throw new RequestError('model must be a non-empty string');
        }
        const model = isAllowListed(request.model);
        if (!model) throw new RequestError('model is not one of the allow-listed OpenCode free models');
        checkRequestOptions(request);
        const normalized = normalizeMessages(request.messages);
        const last = normalized[normalized.length - 1];
        if (last.role !== 'user') throw new RequestError('the last message must have role user');
        if (!last.text.trim()) throw new RequestError('the last user message text is empty');
        const prompt = renderFlattened(normalized);
        if (Buffer.byteLength(prompt, 'utf8') > PROMPT_MAX_BYTES) {
            throw new RequestError(`prompt exceeds ${PROMPT_MAX_BYTES} bytes`);
        }
        return { ok: true, model, prompt, stream: request.stream === true };
    } catch (error) {
        if (error instanceof RequestError) return { ok: false, message: error.message };
        throw error;
    }
}

export function extractOpenAiRequest(payload) {
    const envelope = isPlainObject(payload?.input) ? payload.input : payload;
    return isPlainObject(envelope?.request) ? envelope.request : null;
}
