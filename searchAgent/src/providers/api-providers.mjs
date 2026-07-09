import { provider as brave } from './brave.mjs';
import { provider as duckduckgo } from './duckduckgo.mjs';
import { provider as exa } from './exa.mjs';
import { provider as gemini } from './gemini.mjs';
import { provider as jina } from './jina.mjs';
import { provider as searxng } from './searxng.mjs';
import { provider as serper } from './serper.mjs';
import { provider as tavily } from './tavily.mjs';

export const apiSearchProviders = Object.freeze([
    duckduckgo,
    tavily,
    brave,
    exa,
    serper,
    searxng,
    jina,
    gemini,
]);

