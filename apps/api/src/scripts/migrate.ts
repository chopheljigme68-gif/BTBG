import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';

/**
 * Applies supabase/migrations/*.sql in order and records each one, so it is
 * safe to run again. (You can also paste the files into the Supabase SQL editor
 * or use `supabase db push`.)
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../supabase/migrations');

const client = await pool.connect();
try {
  await client.query(`create table if not exists _btbg_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query<{ name: string }>('select name from _btbg_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) {
      console.log(`  skip  ${f}`);
      continue;
    }
    const sql = await readFile(path.join(dir, f), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into _btbg_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`  apply ${f}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`Migration ${f} failed: ${(err as Error).message}`);
      process.exitCode = 1;
      break;
    }
  }
  // Supabase exposes the public schema over its REST API; RLS with no policies keeps it closed.
  await client.query(`alter table _btbg_migrations enable row level security`);
} finally {
  client.release();
  await pool.end();
}
