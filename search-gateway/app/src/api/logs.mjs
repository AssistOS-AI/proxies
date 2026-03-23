import { sendJson } from '../utils/http-helpers.mjs';
import { queryLogs, getLogCounts } from '../db/logs-dao.mjs';

export const handleLogs = {
  async list(req, res, query) {
    const logs = await queryLogs({
      model: query?.model,
      provider: query?.provider,
      status: query?.status,
      error_type: query?.error_type,
      api_key_id: query?.api_key_id,
      limit: parseInt(query?.limit) || 50,
      offset: parseInt(query?.offset) || 0,
      sort: query?.sort,
      order: query?.order,
    });

    const counts = await getLogCounts();

    sendJson(res, { logs, counts });
  },
};
