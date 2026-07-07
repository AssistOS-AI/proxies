const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000
});

const LOG_PREFIX = '[SearchAgent Settings]';
const SEARCH_AGENT_MCP_PATH = '/searchAgent/mcp';
const SEARCH_AGENT_PRINCIPAL = 'agent:proxies/searchAgent';
const SECRET_KEYS = Object.freeze([
    'TAVILY_API_KEY',
    'BRAVE_API_KEY',
    'EXA_API_KEY',
    'SERPER_API_KEY',
    'JINA_API_KEY'
]);

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        maxResults: normalizeInteger(
            input.maxResults,
            DEFAULT_SETTINGS.maxResults,
            1,
            100
        ),
        maxQueryChars: normalizeInteger(
            input.maxQueryChars,
            DEFAULT_SETTINGS.maxQueryChars,
            1,
            20000
        )
    };
}

function getErrorMessage(error, fallback) {
    if (error instanceof Error) return error.message || fallback;
    if (typeof error === 'string' && error.trim()) return error.trim();
    return fallback;
}

function parseToolPayload(payload) {
    if (payload && typeof payload === 'object') {
        const content = Array.isArray(payload.content) ? payload.content : [];
        if (content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
            try {
                return JSON.parse(content[0].text);
            } catch {
                return payload;
            }
        }
        return payload;
    }
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function assertOkPayload(payload, fallback) {
    if (!payload || typeof payload !== 'object') {
        throw new Error(fallback);
    }
    if (payload.ok === false) {
        throw new Error(payload.error?.message || payload.error || fallback);
    }
    return payload;
}

export class SearchAgentSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            settings: normalizeSettings(),
            secrets: new Map(),
            status: '',
            statusType: ''
        };
        this.invalidate();
    }

    beforeRender() {}

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }

    afterRender() {
        this.cacheElements();
        this.syncInputsFromState();
        this.renderStatus();
        void this.reloadSettings();
    }

    cacheElements() {
        this.inputs = {
            maxResults: this.element.querySelector('#sagMaxResults'),
            maxQueryChars: this.element.querySelector('#sagMaxQueryChars')
        };
        this.secretsGrid = this.element.querySelector('#sagSecretsGrid');
        this.statusElement = this.element.querySelector('#sagSettingsStatus');
        this.renderSecretFields();
    }

    syncInputsFromState() {
        const settings = normalizeSettings(this.state.settings);
        if (this.inputs?.maxResults) {
            this.inputs.maxResults.value = String(settings.maxResults);
        }
        if (this.inputs?.maxQueryChars) {
            this.inputs.maxQueryChars.value = String(settings.maxQueryChars);
        }
    }

    collectSettingsFromInputs() {
        return normalizeSettings({
            maxResults: this.inputs?.maxResults?.value,
            maxQueryChars: this.inputs?.maxQueryChars?.value
        });
    }

    setStatus(message, type = '') {
        this.state.status = message;
        this.state.statusType = type;
        this.renderStatus();
    }

    renderStatus() {
        if (!this.statusElement) return;
        this.statusElement.textContent = this.state.status || '';
        this.statusElement.classList.toggle('error', this.state.statusType === 'error');
        this.statusElement.classList.toggle('success', this.state.statusType === 'success');
    }

    async ensureMcpClient() {
        if (this.mcpClient) return this.mcpClient;
        const module = await import('/MCPBrowserClient.js');
        if (!module || typeof module.createAgentClient !== 'function') {
            throw new Error('MCP browser client is unavailable.');
        }
        this.mcpClient = module.createAgentClient(SEARCH_AGENT_MCP_PATH);
        return this.mcpClient;
    }

    async callSearchAgent(toolName, args = {}) {
        const client = await this.ensureMcpClient();
        const payload = parseToolPayload(await client.callTool(toolName, args));
        return assertOkPayload(payload, `Invalid SearchAgent response for ${toolName}.`);
    }

    async callDpuTool(toolName, args = {}) {
        const directClient = window.webSkel?.appServices?.getClient?.('dpuAgent');
        let result;
        if (directClient && typeof directClient.callTool === 'function') {
            result = await directClient.callTool(toolName, args);
        } else if (window.assistOS?.appServices?.callTool) {
            result = await window.assistOS.appServices.callTool('dpuAgent', toolName, args);
        } else {
            throw new Error('DPU agent is not available.');
        }
        const payload = parseToolPayload(result);
        if (!payload || typeof payload !== 'object') {
            throw new Error(`Invalid DPU response for ${toolName}.`);
        }
        if (payload.ok === false) {
            throw new Error(payload.error?.message || payload.error || `DPU call failed: ${toolName}`);
        }
        return payload;
    }

    renderSecretFields() {
        if (!this.secretsGrid) return;
        this.secretsGrid.replaceChildren(...SECRET_KEYS.map((key) => {
            const row = document.createElement('div');
            row.className = 'sag-secret-row';
            row.dataset.secretKey = key;

            const label = document.createElement('div');
            label.className = 'sag-secret-label';
            const name = document.createElement('div');
            name.className = 'sag-secret-name';
            name.textContent = key;
            const state = document.createElement('div');
            state.className = 'sag-secret-state';
            state.dataset.secretState = key;
            state.textContent = '';
            label.append(name, state);

            const input = document.createElement('input');
            input.className = 'form-input';
            input.type = 'password';
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.placeholder = 'Leave blank to keep current value';
            input.dataset.secretInput = key;

            const clearButton = document.createElement('button');
            clearButton.className = 'sag-secret-clear';
            clearButton.type = 'button';
            clearButton.dataset.secretClear = key;
            clearButton.textContent = 'Clear';
            clearButton.addEventListener('click', () => {
                void this.clearSecret(key);
            });

            row.append(label, input, clearButton);
            return row;
        }));
    }

    async reloadSecrets() {
        const entries = await Promise.all(SECRET_KEYS.map(async (key) => {
            try {
                const payload = await this.callDpuTool('dpu_secret_get', { key });
                return [key, Boolean(payload.secret?.valueVisible && typeof payload.secret?.value === 'string')];
            } catch {
                return [key, false];
            }
        }));
        this.state.secrets = new Map(entries);
        for (const [key, configured] of entries) {
            const state = this.element.querySelector(`[data-secret-state="${key}"]`);
            if (state) state.textContent = configured ? 'Configured' : 'Not configured';
        }
    }

    collectSecretChanges() {
        return SECRET_KEYS.map((key) => {
            const input = this.element.querySelector(`[data-secret-input="${key}"]`);
            return {
                key,
                value: typeof input?.value === 'string' ? input.value : ''
            };
        }).filter((entry) => entry.value);
    }

    async clearSecret(key) {
        this.setStatus('Clearing...');
        try {
            await this.callDpuTool('dpu_secret_delete', { key });
        } catch (error) {
            if (!String(error?.message || '').includes('not found')) {
                console.error(`${LOG_PREFIX} Failed to clear secret.`, error);
                this.setStatus(getErrorMessage(error, 'Clear failed.'), 'error');
                return;
            }
        }
        const input = this.element.querySelector(`[data-secret-input="${key}"]`);
        const state = this.element.querySelector(`[data-secret-state="${key}"]`);
        if (input) input.value = '';
        if (state) state.textContent = 'Not configured';
        this.state.secrets.set(key, false);
        this.setStatus('Cleared.', 'success');
    }

    async saveSecretChanges() {
        const changes = this.collectSecretChanges();
        for (const change of changes) {
            await this.callDpuTool('dpu_secret_put', {
                key: change.key,
                value: change.value,
                displayName: `SearchAgent ${change.key}`
            });
            await this.callDpuTool('dpu_secret_grant', {
                key: change.key,
                principal: SEARCH_AGENT_PRINCIPAL,
                role: 'read'
            });
        }
        for (const key of SECRET_KEYS) {
            const input = this.element.querySelector(`[data-secret-input="${key}"]`);
            if (input) input.value = '';
        }
    }

    async reloadSettings() {
        this.setStatus('Loading...');
        try {
            const payload = await this.callSearchAgent('search_agent_get_settings', {});
            this.state.settings = normalizeSettings(payload.settings);
            this.syncInputsFromState();
            await this.reloadSecrets();
            this.setStatus('');
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to load settings.`, error);
            this.setStatus(getErrorMessage(error, 'Load failed.'), 'error');
        }
    }

    async saveSettings() {
        this.setStatus('Saving...');
        try {
            const settings = this.collectSettingsFromInputs();
            const payload = await this.callSearchAgent('search_agent_update_settings', settings);
            this.state.settings = normalizeSettings(payload.settings);
            this.syncInputsFromState();
            await this.saveSecretChanges();
            await this.reloadSecrets();
            this.setStatus('Saved.', 'success');
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to save settings.`, error);
            this.setStatus(getErrorMessage(error, 'Save failed.'), 'error');
            throw error;
        }
    }
}
