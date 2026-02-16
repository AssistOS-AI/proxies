import { createServer } from 'node:http';
import { handleCors, parseUrl, sendJson, sendError } from './utils/http-helpers.mjs';
import { createLogger } from './utils/logger.mjs';
import { pipeline } from './pipeline/pipeline.mjs';
import { apiRouter } from './api/router.mjs';
import { handleUpgrade } from './ws/upgrade.mjs';
import { serveDashboard } from './dashboard/serve.mjs';
import { config } from './config.mjs';

const log = createLogger('server');

export function createAppServer() {
  const server = createServer(async (req, res) => {
    if (handleCors(req, res)) return;

    const { pathname, query } = parseUrl(req);

    try {
      // Health check
      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, { status: 'ok', uptime: process.uptime() });
      }

      // OpenAI-compatible agent endpoints
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        return await pipeline(req, res);
      }
      if (pathname === '/v1/models' && req.method === 'GET') {
        // Handled by API router (lists models for the authenticated family)
        return await apiRouter(req, res, pathname, query);
      }

      // Management API
      if (pathname.startsWith('/api/v1/')) {
        return await apiRouter(req, res, pathname, query);
      }

      // Dashboard SPA (static files)
      if (pathname === '/' || pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname === '/favicon.ico') {
        return serveDashboard(req, res, pathname);
      }
      // Dashboard SPA routes (client-side routing)
      if (['logs', 'costs', 'errors', 'families', 'models', 'keys', 'blacklist'].some(p => pathname === `/${p}`)) {
        return serveDashboard(req, res, '/');
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      log.error('Unhandled error', { path: pathname, error: err.message, stack: err.stack });
      if (!res.headersSent) {
        sendError(res, err.status || 500, err.message, err.type || 'internal_error');
      }
    }
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });

  return server;
}

export function startServer(server) {
  return new Promise((resolve) => {
    server.listen(config.port, () => {
      log.info(`Soul Gateway listening on port ${config.port}`);
      resolve(server);
    });
  });
}
