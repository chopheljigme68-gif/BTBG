import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { JOBS } from './registry.js';

/**
 * Runs scheduled jobs in Bhutan Time. A Postgres advisory lock per job means
 * only one API instance runs a given job at a time.
 */
export async function runJob(name: string) {
  const job = JOBS[name];
  if (!job) throw new Error(`Unknown job ${name}`);
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [`job:${name}`]);
    if (!rows[0]?.ok) return null;
    try {
      const started = Date.now();
      const result = await job.run();
      if (name !== 'dispatch_notifications' || Object.values(result).some((v) => v !== 0)) {
        logger.info({ job: name, result, ms: Date.now() - started }, 'job finished');
      }
      return result;
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [`job:${name}`]);
    }
  } finally {
    client.release();
  }
}

export function startScheduler() {
  const tasks = Object.entries(JOBS).map(([name, job]) =>
    cron.schedule(job.schedule, () => {
      runJob(name).catch((err) => logger.error({ err, job: name }, 'job failed'));
    }, { timezone: 'Asia/Thimphu', name }),
  );
  logger.info(`scheduler started with ${tasks.length} jobs`);
  return () => tasks.forEach((t) => t.stop());
}
