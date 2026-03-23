import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const cache = new Map();

export function serveDashboard(req, res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = join(PUBLIC_DIR, 'index.html');
  } else {
    filePath = join(PUBLIC_DIR, pathname);
  }

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!existsSync(filePath)) {
    // SPA fallback — serve index.html for unknown routes
    filePath = join(PUBLIC_DIR, 'index.html');
  }

  try {
    let content = cache.get(filePath);
    if (!content) {
      content = readFileSync(filePath);
      cache.set(filePath, content);
    }

    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}
