const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000
});

const DEFAULT_SEARXNG_SETTINGS = Object.freeze({
    categories: 'general,scientific_publications',
    language: 'en',
    timeRange: '',
    safeSearch: 1,
    page: 1
});

const VALID_TIME_RANGES = new Set(['', 'day', 'month', 'year']);

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

function normalizeCategories(value, fallback) {
    const raw = typeof value === 'string' ? value : '';
    const categories = raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^[a-z0-9_-]+$/.test(item));
    return categories.length ? [...new Set(categories)].join(',') : fallback;
}

function normalizeLanguage(value, fallback) {
    const raw = typeof value === 'string' ? value.trim() : '';
    return /^[a-zA-Z]{2,3}(-[a-zA-Z]{2})?$/.test(raw) ? raw : fallback;
}

function normalizeTimeRange(value, fallback) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return VALID_TIME_RANGES.has(raw) ? raw : fallback;
}

function normalizeSearxngSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        categories: normalizeCategories(input.categories, DEFAULT_SEARXNG_SETTINGS.categories),
        language: normalizeLanguage(input.language, DEFAULT_SEARXNG_SETTINGS.language),
        timeRange: normalizeTimeRange(input.timeRange, DEFAULT_SEARXNG_SETTINGS.timeRange),
        safeSearch: normalizeInteger(input.safeSearch, DEFAULT_SEARXNG_SETTINGS.safeSearch, 0, 2),
        page: normalizeInteger(input.page, DEFAULT_SEARXNG_SETTINGS.page, 1, 10)
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
            activeTab: 'general',
            settings: normalizeSettings(),
            searxngSettings: normalizeSearxngSettings(),
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
            maxQueryChars: this.element.querySelector('#sagMaxQueryChars'),
            searxngCategories: this.element.querySelector('#sagSearxngCategories'),
            searxngLanguage: this.element.querySelector('#sagSearxngLanguage'),
            searxngTimeRange: this.element.querySelector('#sagSearxngTimeRange'),
            searxngSafeSearch: this.element.querySelector('#sagSearxngSafeSearch'),
            searxngPage: this.element.querySelector('#sagSearxngPage')
        };
        this.tabButtons = [...this.element.querySelectorAll('[data-sag-tab]')];
        this.tabPanels = [...this.element.querySelectorAll('[data-sag-panel]')];
        this.secretsGrid = this.element.querySelector('#sagSecretsGrid');
        this.statusElement = this.element.querySelector('#sagSettingsStatus');
        this.tabButtons.forEach((button) => {
            button.addEventListener('click', () => {
                this.setActiveTab(button.dataset.sagTab || 'general');
            });
        });
        this.renderSecretFields();
    }

    setActiveTab(tab) {
        const nextTab = tab === 'searxng' ? 'searxng' : 'general';
        this.state.activeTab = nextTab;
        this.tabButtons?.forEach((button) => {
            const active = button.dataset.sagTab === nextTab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        this.tabPanels?.forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.sagPanel === nextTab);
        });
    }

    syncInputsFromState() {
        const settings = normalizeSettings(this.state.settings);
        if (this.inputs?.maxResults) {
            this.inputs.maxResults.value = String(settings.maxResults);
        }
        if (this.inputs?.maxQueryChars) {
            this.inputs.maxQueryChars.value = String(settings.maxQueryChars);
        }
        this.syncSearxngInputsFromState();
    }

    syncSearxngInputsFromState() {
        const settings = normalizeSearxngSettings(this.state.searxngSettings);
        if (this.inputs?.searxngCategories) {
            const selected = new Set(settings.categories.split(',').map((item) => item.trim()).filter(Boolean));
            this.inputs.searxngCategories.querySelectorAll('[data-searxng-category]').forEach((input) => {
                input.checked = selected.has(input.value);
            });
        }
        if (this.inputs?.searxngLanguage) {
            this.inputs.searxngLanguage.value = settings.language;
        }
        if (this.inputs?.searxngTimeRange) {
            this.inputs.searxngTimeRange.value = settings.timeRange;
        }
        if (this.inputs?.searxngSafeSearch) {
            this.inputs.searxngSafeSearch.value = String(settings.safeSearch);
        }
        if (this.inputs?.searxngPage) {
            this.inputs.searxngPage.value = String(settings.page);
        }
    }

    collectSettingsFromInputs() {
        return normalizeSettings({
            maxResults: this.inputs?.maxResults?.value,
            maxQueryChars: this.inputs?.maxQueryChars?.value
        });
    }

    collectSearxngSettingsFromInputs() {
        const categories = this.inputs?.searxngCategories
            ? [...this.inputs.searxngCategories.querySelectorAll('[data-searxng-category]:checked')]
                .map((input) => input.value)
                .join(',')
            : '';
        return normalizeSearxngSettings({
            categories,
            language: this.inputs?.searxngLanguage?.value,
            timeRange: this.inputs?.searxngTimeRange?.value,
            safeSearch: this.inputs?.searxngSafeSearch?.value,
            page: this.inputs?.searxngPage?.value
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
            const searxngPayload = await this.callSearchAgent('search_agent_get_searxng_settings', {});
            this.state.settings = normalizeSettings(payload.settings);
            this.state.searxngSettings = normalizeSearxngSettings(searxngPayload.settings);
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
            if (this.state.activeTab === 'searxng') {
                await this.saveSearxngSettings();
                return;
            }
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

    async saveSearxngSettings() {
        const settings = this.collectSearxngSettingsFromInputs();
        const payload = await this.callSearchAgent('search_agent_update_searxng_settings', settings);
        this.state.searxngSettings = normalizeSearxngSettings(payload.settings);
        this.syncSearxngInputsFromState();
        this.setStatus('Saved.', 'success');
    }
}
