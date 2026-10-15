import pg from 'pg';
import { env } from '../config/env.js';

// Return NUMERIC as JS numbers (amounts are well within double precision and
// always rounded to 2 dp), DATE as 'YYYY-MM-DD' strings to avoid TZ drift.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: env.isTest ? 5 : 15,
  idleTimeoutMillis: 30_000,
});

export type Db = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  const rows = await query<T>(text, params, db);
  return rows[0] as T | undefined;
}

/**
 * Run fn inside a transaction. Payroll, invoicing and placement state changes
 * always go through here so a failure never leaves partial records (NFR-REL-05).
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
