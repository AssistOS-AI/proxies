import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/models-dao.mjs';

export const handleModels = {
  async list(req, res, query) {
    const enabledOnly = query?.enabled === 'true';
    const models = await dao.listModels(enabledOnly);
    sendJson(res, models);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name) {
      return sendError(res, 400, 'name is required');
    }
    try {
      const model = await dao.createModel(body);
      sendJson(res, model, 201);
    } catch (err) {
      if (err.code === '23505') {
        return sendError(res, 409, `Model "${body.name}" already exists`);
      }
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const model = await dao.updateModel(params.id, body);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, model);
  },

  async toggle(req, res, params) {
    const model = await dao.toggleModel(params.id);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, model);
  },

  async remove(req, res, params) {
    const model = await dao.deleteModel(params.id);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, { ok: true });
  },
};
