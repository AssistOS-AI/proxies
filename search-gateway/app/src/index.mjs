import { initDb } from './db/init.mjs';
import { startServer } from './server.mjs';
import { createLogger } from './utils/logger.mjs';

const log = createLogger('main');

async function main() {
  log.info('Initializing Search Gateway...');

  try {
    await initDb();
    startServer();
  } catch (err) {
    log.critical('Failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

main();
