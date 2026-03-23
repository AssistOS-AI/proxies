import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/keys-dao.mjs';

export const handleKeys = {
  async list(req, res, query) {
    const keys = await dao.listKeys();
    sendJson(res, keys);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    const key = await dao.createKey({
      label: body?.label,
      rpm_limit: body?.rpm_limit,
      expires_at: body?.expires_at,
    });
    sendJson(res, key, 201);
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const key = await dao.updateKey(params.id, body);
    if (!key) return sendError(res, 404, 'Key not found');
    sendJson(res, key);
  },

  async revoke(req, res, params) {
    const ok = await dao.revokeKey(params.id);
    if (!ok) return sendError(res, 404, 'Key not found');
    sendJson(res, { ok: true });
  },
};
