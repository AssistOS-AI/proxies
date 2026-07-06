const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000
});

const LOG_PREFIX = '[SearchAgent Settings]';
const SETTINGS_URL = '/services/search-agent/settings';

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

async function requestSettings(method, body = undefined) {
    const response = await fetch(SETTINGS_URL, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = {};
    }
    if (!response.ok) {
        const message = payload?.error?.message || payload?.error || `Settings request failed with HTTP ${response.status}.`;
        throw new Error(message);
    }
    return payload;
}

export class SearchAgentSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            settings: normalizeSettings(),
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
        this.statusElement = this.element.querySelector('#sagSettingsStatus');
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

    async reloadSettings() {
        this.setStatus('Loading...');
        try {
            const payload = await requestSettings('GET');
            if (payload?.error) {
                throw new Error(payload.error.message || 'Invalid settings payload.');
            }
            this.state.settings = normalizeSettings(payload.settings);
            this.syncInputsFromState();
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
            const payload = await requestSettings('POST', settings);
            if (payload?.error) {
                throw new Error(payload.error.message || 'Invalid settings payload.');
            }
            this.state.settings = normalizeSettings(payload.settings);
            this.syncInputsFromState();
            this.setStatus('Saved.', 'success');
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to save settings.`, error);
            this.setStatus(getErrorMessage(error, 'Save failed.'), 'error');
            throw error;
        }
    }
}
