import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/providers-dao.mjs';
import * as modelsDao from '../db/models-dao.mjs';
import { createProvider } from '../providers/registry.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('api-providers');

export const handleProviders = {
  async list(req, res, query) {
    const enabledOnly = query?.enabled === 'true';
    const providers = await dao.listProviders(enabledOnly);
    sendJson(res, providers);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name || !body?.provider_type) {
      return sendError(res, 400, 'name and provider_type are required');
    }
    try {
      const provider = await dao.createProvider(body);

      // Auto-create corresponding search model
      const modelName = `${provider.name}-search`;
      try {
        await modelsDao.createModel({
          name: modelName,
          display_name: `${provider.display_name || provider.name} Search`,
          provider_id: provider.id,
          model_type: 'search',
          sort_order: provider.sort_order || 100,
        });
        log.info(`Auto-created model: ${modelName}`);
      } catch (err) {
        // Model may already exist — not fatal
        if (err.code !== '23505') log.warn(`Failed to auto-create model ${modelName}`, { error: err.message });
      }

      sendJson(res, provider, 201);
    } catch (err) {
      if (err.code === '23505') {
        return sendError(res, 409, `Provider "${body.name}" already exists`);
      }
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const provider = await dao.updateProvider(params.id, body);
    if (!provider) return sendError(res, 404, 'Provider not found');
    sendJson(res, provider);
  },

  async remove(req, res, params) {
    // Delete associated search model(s) first
    await modelsDao.deleteByProviderId(params.id);
    const provider = await dao.deleteProvider(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    sendJson(res, { ok: true });
  },

  async test(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');

    let apiKey = null;
    if (provider.provider_type !== 'duckduckgo' && provider.provider_type !== 'searxng') {
      apiKey = await dao.getProviderApiKey(params.id);
    }

    try {
      const prov = createProvider(provider.provider_type, apiKey, provider.base_url, provider.config || {});
      const results = await prov.search('test query', { max_results: 1 });
      sendJson(res, { ok: true, result_count: results.length, sample: results[0] || null });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message });
    }
  },
};
