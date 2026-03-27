import { copilotHeaders } from '../auth/copilot-token.mjs';
import { config } from '../config.mjs';
import { sendJson, sendError } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('proxy:models');

export async function handleModels(req, res) {
  try {
    const response = await fetch(`${config.copilotBaseUrl}/models`, {
      headers: copilotHeaders(),
    });

    if (!response.ok) {
      log.error('Upstream /models request failed', { status: response.status });
      const text = await response.text().catch(() => '');
      return sendError(res, response.status, `Upstream error: ${response.status} ${text}`);
    }

    const upstream = await response.json();

    const models = Array.isArray(upstream?.data) ? upstream.data : [];
    const result = {
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.vendor || 'copilot',
      })),
    };

    log.debug('Models response', { count: result.data.length });
    sendJson(res, result);
  } catch (err) {
    log.error('Failed to fetch models', { error: err.message });
    sendError(res, 502, `Failed to fetch models: ${err.message}`);
  }
}
