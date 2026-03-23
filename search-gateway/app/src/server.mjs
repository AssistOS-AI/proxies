import { createServer } from 'node:http';
import { pipeline } from './pipeline/pipeline.mjs';
import { readJsonBody, sendJson, sendError, handleCors, parseUrl } from './utils/http-helpers.mjs';
import { apiRouter } from './api/router.mjs';
import { handleLogin, handleLogout, checkSession } from './dashboard/auth.mjs';
import { serveDashboard } from './dashboard/serve.mjs';
import { handleWsUpgrade } from './ws/upgrade.mjs';
import { listModels } from './db/models-dao.mjs';
import { config } from './config.mjs';
import { createLogger } from './utils/logger.mjs';

const log = createLogger('server');

export function startServer() {
  const server = createServer(async (req, res) => {
    try {
      if (handleCors(req, res)) return;

      const { pathname, query } = parseUrl(req);

      // Health check
      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, { status: 'ok', service: 'search-gateway', timestamp: new Date().toISOString() });
      }

      // Agent-facing: /v1/chat/completions
      if ((pathname === '/v1/chat/completions' || pathname === '/chat/completions') && req.method === 'POST') {
        const body = await readJsonBody(req);
        return await pipeline(req, res, body);
      }

      // Agent-facing: /v1/models
      if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
        const models = await listModels(true);
        return sendJson(res, {
          object: 'list',
          data: models.filter(m => m.is_enabled).map(m => ({
            id: m.name,
            object: 'model',
            created: Math.floor(new Date(m.created_at).getTime() / 1000),
            owned_by: 'search-gateway',
            mode: m.model_type === 'research' ? 'deep' : 'fast',
            input_price: 0,
            output_price: 0,
            sort_order: m.sort_order ?? 100,
            is_free: m.model_type !== 'research',
          })),
        });
      }

      // Dashboard auth
      if (pathname === '/login') return handleLogin(req, res);
      if (pathname === '/logout') return handleLogout(req, res);

      // Management API (protected)
      if (pathname.startsWith('/api/v1/')) {
        if (config.dashboardPassword && !checkSession(req)) {
          return sendError(res, 401, 'Dashboard authentication required');
        }
        return await apiRouter(req, res, pathname, query);
      }

      // Dashboard SPA
      if (pathname === '/' || pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
        if (config.dashboardPassword && pathname === '/' && !checkSession(req)) {
          // Redirect to login
          res.writeHead(302, { Location: '/login' });
          return res.end();
        }
        return serveDashboard(req, res, pathname);
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      log.error('Unhandled error', { error: err.message, stack: err.stack });
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    }
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    handleWsUpgrade(req, socket, head);
  });

  server.listen(config.port, () => {
    log.info(`Search Gateway listening on port ${config.port}`);
  });

  return server;
}
