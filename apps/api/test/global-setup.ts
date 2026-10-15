import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { TEST_ENV } from './test-env.js';

/**
 * Creates a fresh test database, applies the migrations and loads the demo
 * data, so every run starts from the same known state.
 */
export default async function setup() {
  const url = new URL(TEST_ENV.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  await client.query(`drop database if exists "${dbName}"`);
  await client.query(`create database "${dbName}"`);
  await client.end();

  const cwd = path.resolve(import.meta.dirname, '..');
  const env = { ...process.env, ...TEST_ENV };
  for (const script of ['src/scripts/migrate.ts', 'src/scripts/seed-demo.ts']) {
    execFileSync('npx', ['tsx', script], { cwd, env, stdio: 'pipe' });
  }
}
