const PROVIDER_SECRET_KEYS = Object.freeze([
    'TAVILY_API_KEY',
    'BRAVE_API_KEY',
    'EXA_API_KEY',
    'SERPER_API_KEY',
    'JINA_API_KEY',
]);

let cachedDpuClient = null;

export function providerSecretKeys() {
    return [...PROVIDER_SECRET_KEYS];
}

async function getDpuClient() {
    if (cachedDpuClient) return cachedDpuClient;
    const module = await import('/Agent/client/AgentMcpClient.mjs');
    if (!module || typeof module.createAgentClient !== 'function') {
        throw new Error('AgentMcpClient module does not expose createAgentClient.');
    }
    cachedDpuClient = await module.createAgentClient('dpuAgent');
    return cachedDpuClient;
}

export async function readDpuSecret(key, { dpuClient = null } = {}) {
    const client = dpuClient || await getDpuClient();
    const result = await client.callTool('dpu_agent_secret_get', { key });
    if (!result || typeof result !== 'object') {
        throw new Error(`Invalid DPU response for ${key}.`);
    }
    if (result.ok === false) {
        return '';
    }
    const value = result.secret?.value;
    return typeof value === 'string' ? value : '';
}

export async function loadProviderSecretEnv({ env = process.env, dpuClient = null, keys = PROVIDER_SECRET_KEYS } = {}) {
    const requiredKeys = Array.isArray(keys) ? keys.filter((key) => PROVIDER_SECRET_KEYS.includes(key)) : [];
    const output = { ...env };
    const missingKeys = requiredKeys.filter((key) => !(typeof output[key] === 'string' && output[key]));
    if (!missingKeys.length) return output;
    const client = dpuClient || await getDpuClient();
    await Promise.all(missingKeys.map(async (key) => {
        if (typeof output[key] === 'string' && output[key]) return;
        output[key] = await readDpuSecret(key, { dpuClient: client });
    }));
    return output;
}
