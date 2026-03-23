import { corsHeaders } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('log-stream');
const subscribers = new Set();

/**
 * Broadcast a log entry to all connected subscribers.
 */
export function broadcastLog(logEntry) {
  const data = JSON.stringify(logEntry);
  for (const sub of subscribers) {
    try {
      sub.write(`data: ${data}\n\n`);
    } catch {
      subscribers.delete(sub);
    }
  }
}

/**
 * SSE endpoint for log streaming.
 */
export function handleSseStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders(),
  });

  subscribers.add(res);
  log.debug('SSE subscriber connected', { total: subscribers.size });

  // Keepalive
  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 15000);

  req.on('close', () => {
    subscribers.delete(res);
    clearInterval(keepalive);
    log.debug('SSE subscriber disconnected', { total: subscribers.size });
  });
}
