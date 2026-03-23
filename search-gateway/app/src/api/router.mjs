import { matchPath, sendError } from '../utils/http-helpers.mjs';
import { handleKeys } from './keys.mjs';
import { handleProviders } from './providers.mjs';
import { handleModels } from './models.mjs';
import { handleLogs } from './logs.mjs';
import { handleMetrics } from './metrics.mjs';

export async function apiRouter(req, res, pathname, query) {
  const method = req.method;

  // Keys
  if (pathname === '/api/v1/keys') {
    if (method === 'GET') return handleKeys.list(req, res, query);
    if (method === 'POST') return handleKeys.create(req, res);
  }
  let params = matchPath('/api/v1/keys/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleKeys.update(req, res, params);
    if (method === 'DELETE') return handleKeys.revoke(req, res, params);
  }

  // Providers
  if (pathname === '/api/v1/providers') {
    if (method === 'GET') return handleProviders.list(req, res, query);
    if (method === 'POST') return handleProviders.create(req, res);
  }
  params = matchPath('/api/v1/providers/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleProviders.update(req, res, params);
    if (method === 'DELETE') return handleProviders.remove(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/test', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.test(req, res, params);
  }

  // Models
  if (pathname === '/api/v1/models') {
    if (method === 'GET') return handleModels.list(req, res, query);
    if (method === 'POST') return handleModels.create(req, res);
  }
  params = matchPath('/api/v1/models/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.update(req, res, params);
    if (method === 'DELETE') return handleModels.remove(req, res, params);
  }
  params = matchPath('/api/v1/models/:id/toggle', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.toggle(req, res, params);
  }

  // Logs
  if (pathname === '/api/v1/logs') {
    if (method === 'GET') return handleLogs.list(req, res, query);
  }

  // Metrics
  if (pathname === '/api/v1/metrics/summary') {
    if (method === 'GET') return handleMetrics.summary(req, res, query);
  }
  if (pathname === '/api/v1/metrics/providers') {
    if (method === 'GET') return handleMetrics.providers(req, res, query);
  }
  if (pathname === '/api/v1/metrics/errors') {
    if (method === 'GET') return handleMetrics.errors(req, res, query);
  }

  sendError(res, 404, 'API endpoint not found');
}
