import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleCors, parseUrl, sendJson, sendError, readJsonBody, corsHeaders } from './utils/http-helpers.mjs';
import { createLogger } from './utils/logger.mjs';
import { config } from './config.mjs';
import { copilotHeaders } from './auth/copilot-token.mjs';
import { handleModels } from './proxy/models.mjs';
import { handleCompletions } from './proxy/completions.mjs';
import { handleResponsesDirect, handleResponsesTranslated } from './proxy/responses.mjs';
import { getEndpointForModel, cacheEndpoint } from './proxy/endpoint-router.mjs';

const log = createLogger('server');

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Invalid JSON body');
  }

  if (!body || !body.model || !body.messages) {
    return sendError(res, 400, 'Request body must include "model" and "messages"');
  }

  const headers = copilotHeaders();
  const requestId = 'chatcmpl-' + randomUUID();
  const endpoint = getEndpointForModel(body.model);

  try {
    if (endpoint === 'completions') {
      await handleCompletions(body, req, res, headers);
    } else {
      await handleResponsesTranslated(body, req, res, headers, requestId);
    }
  } catch (err) {
    if (err.code === 'UNSUPPORTED_API_FOR_MODEL' && !res.headersSent) {
      if (endpoint === 'completions') {
        cacheEndpoint(body.model, 'responses');
        log.info('Falling back to responses endpoint', { model: body.model });
        try {
          await handleResponsesTranslated(body, req, res, headers, requestId);
        } catch (retryErr) {
          if (!res.headersSent) {
            sendError(res, retryErr.status || 502, retryErr.message);
          }
        }
      } else {
        cacheEndpoint(body.model, 'completions');
        log.info('Falling back to completions endpoint', { model: body.model });
        try {
          await handleCompletions(body, req, res, headers);
        } catch (retryErr) {
          if (!res.headersSent) {
            sendError(res, retryErr.status || 502, retryErr.message);
          }
        }
      }
    } else if (!res.headersSent) {
      sendError(res, err.status || 502, err.message);
    }
  }
}

async function handleResponsesRoute(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Invalid JSON body');
  }

  if (!body || !body.model) {
    return sendError(res, 400, 'Request body must include "model"');
  }

  const headers = copilotHeaders();

  try {
    await handleResponsesDirect(body, req, res, headers);
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, err.status || 502, err.message);
    }
  }
}

export function createAppServer() {
  const server = createServer(async (req, res) => {
    if (handleCors(req, res)) return;
    const { pathname } = parseUrl(req);

    try {
      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, { status: 'ok', uptime: process.uptime() });
      }

      if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
        return handleModels(req, res);
      }

      if ((pathname === '/v1/chat/completions' || pathname === '/chat/completions') && req.method === 'POST') {
        return handleChatCompletions(req, res);
      }

      if ((pathname === '/v1/responses' || pathname === '/responses') && req.method === 'POST') {
        return handleResponsesRoute(req, res);
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      log.error('Unhandled error', { error: err.message });
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    }
  });
  return server;
}

export function startServer(server) {
  return new Promise(resolve => {
    server.listen(config.port, () => {
      log.info(`Copilot Gateway listening on port ${config.port}`);
      resolve(server);
    });
  });
}
