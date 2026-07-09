#!/usr/bin/env node
import { handleSearch } from '../tools/search.mjs';

const DEFAULT_MAX_RESULTS = 10;

function completionId() {
    return `chatcmpl-search-${Date.now().toString(36)}`;
}

function unixSeconds() {
    return Math.floor(Date.now() / 1000);
}

function openAiCompletion({ model, content }) {
    return {
        id: completionId(),
        object: 'chat.completion',
        created: unixSeconds(),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                },
                finish_reason: 'stop',
            },
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

function writeSseCompletion(completion) {
    const choice = completion?.choices?.[0] || {};
    const message = choice.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const base = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
    };
    process.stdout.write(`data: ${JSON.stringify({
        ...base,
        choices: [
            {
                index: 0,
                delta: {
                    role: 'assistant',
                    content,
                },
                finish_reason: null,
            },
        ],
    })}\n\n`);
    process.stdout.write(`data: ${JSON.stringify({
        ...base,
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: choice.finish_reason || 'stop',
            },
        ],
    })}\n\n`);
    process.stdout.write('data: [DONE]\n\n');
}

async function readStdinJson() {
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    if (!raw.trim()) return {};
    return JSON.parse(raw);
}

function contentPartToText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'text' && typeof part.content === 'string') return part.content;
    return '';
}

function messageContentToText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .map(contentPartToText)
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text.trim();
    }
    return '';
}

function extractSearchRequest(payload) {
    const request = extractOpenAiRequest(payload);
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const userMessage = [...messages]
        .reverse()
        .find((message) => message?.role === 'user' && messageContentToText(message.content));
    const query = userMessage ? messageContentToText(userMessage.content) : '';

    return {
        query,
        maxResults: DEFAULT_MAX_RESULTS,
        model: typeof request?.model === 'string' ? request.model.trim() : '',
    };
}

function extractOpenAiRequest(payload) {
    const envelope = payload?.input && typeof payload.input === 'object'
        ? payload.input
        : payload;
    return envelope?.request && typeof envelope.request === 'object'
        ? envelope.request
        : envelope;
}

function invalidSearchPayload(query, message) {
    return {
        ok: false,
        query,
        maxResults: DEFAULT_MAX_RESULTS,
        error: {
            code: 'INVALID_REQUEST',
            message,
            retryable: false,
        },
        results: [],
    };
}

async function handleChatCompletions(payload) {
    const { query, maxResults, model } = extractSearchRequest(payload);

    if (!query) {
        return openAiCompletion({
            model,
            content: JSON.stringify(invalidSearchPayload(query, 'a user prompt is required as the search query.')),
        });
    }

    let searchPayload;
    try {
        searchPayload = await handleSearch({ query, maxResults });
    } catch (error) {
        searchPayload = {
            ok: false,
            error: {
                code: error?.code || 'SEARCH_AGENT_TOOL_FAILED',
                message: error?.message || 'SearchAgent tool failed.',
                retryable: Boolean(error?.retryable),
                ...(error?.details && Object.keys(error.details).length ? { details: error.details } : {}),
            },
            results: [],
        };
    }

    return openAiCompletion({
        model,
        content: JSON.stringify({
            query,
            maxResults,
            ...searchPayload,
        }),
    });
}

try {
    const payload = await readStdinJson();
    const completion = await handleChatCompletions(payload);
    const request = extractOpenAiRequest(payload);
    if (request?.stream === true) {
        writeSseCompletion(completion);
    } else {
        process.stdout.write(JSON.stringify(completion));
    }
} catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
}
