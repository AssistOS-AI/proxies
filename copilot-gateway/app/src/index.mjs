import { initialize } from './auth/copilot-token.mjs';
import { createAppServer, startServer } from './server.mjs';
import { createLogger } from './utils/logger.mjs';

const log = createLogger('main');

async function main() {
  log.info('Starting Copilot Gateway...');

  await initialize();
  log.info('Authentication initialized');

  const server = createAppServer();
  await startServer(server);

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  log.critical('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
