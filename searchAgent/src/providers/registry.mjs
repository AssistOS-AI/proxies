import { apiSearchProviders } from './api-providers.mjs';
import { provider as deepResearch } from './deep-research.mjs';
import { provider as googleAiMode } from './google-ai-mode.mjs';

export const providers = Object.freeze([
    ...apiSearchProviders,
    deepResearch,
    googleAiMode,
]);

export const providerMap = new Map(providers.map((provider) => [provider.key, provider]));

