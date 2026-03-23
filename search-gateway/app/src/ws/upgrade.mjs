import { createLogger } from '../utils/logger.mjs';

const log = createLogger('ws');

export function handleWsUpgrade(req, socket, head) {
  // Phase 4 will implement real-time log streaming
  log.debug('WebSocket upgrade requested', { url: req.url });
  socket.destroy();
}
