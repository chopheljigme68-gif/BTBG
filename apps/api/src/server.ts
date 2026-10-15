import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { startScheduler } from './jobs/scheduler.js';
import { logger } from './lib/logger.js';
import { ensureBucket } from './lib/storage.js';

const app = createApp();

await ensureBucket().catch((err) => logger.warn({ err }, 'could not ensure storage bucket'));

const server = app.listen(env.PORT, () => {
  logger.info(`BTBG API listening on :${env.PORT} (storage: ${env.supabaseStorage ? 'supabase' : 'local disk'})`);
});

const stopJobs = env.runJobs ? startScheduler() : () => undefined;

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopJobs();
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
