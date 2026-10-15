#!/usr/bin/env node
/**
 * Cross-platform launcher used by every root npm script.
 *
 * It works out all paths from this file's own location, so it does not matter
 * which folder the command is run from, whether the path contains spaces, or
 * whether the shell is cmd, PowerShell, Git Bash or a Unix shell. It loads the
 * root .env, then starts node directly (no shell) in the right app folder.
 *
 *   node scripts/run.mjs dev                 API and website together
 *   node scripts/run.mjs api <task> [args]   task: dev | start | migrate | seed | create-admin
 *   node scripts/run.mjs web <task>          task: dev | start | build
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'apps', 'api');
const webDir = path.join(root, 'apps', 'web');
// .env.local is accepted too, and its values win over .env.
const envFiles = ['.env.local', '.env'].map((f) => path.join(root, f));

function loadEnv() {
  const found = envFiles.filter(existsSync);
  for (const file of found) loadEnvFile(file);
  return found.length > 0;
}

function loadEnvFile(file) {
  for (const raw of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"]).*\1$/.test(value);
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    // Values already set in the real environment win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bin(fromDir, specifier) {
  try {
    return createRequire(path.join(fromDir, 'package.json')).resolve(specifier);
  } catch {
    console.error(`Could not find ${specifier.split('/')[0]}. Run "npm install" in ${root} first.`);
    process.exit(1);
  }
}

const API_TASKS = {
  dev: ['watch', 'src/server.ts'],
  migrate: ['src/scripts/migrate.ts'],
  seed: ['src/scripts/seed-demo.ts'],
  'create-admin': ['src/scripts/create-admin.ts'],
};
const WEB_TASKS = { dev: ['dev', '-p', '3000'], start: ['start', '-p', '3000'], build: ['build'] };

function api(task, extra) {
  if (task === 'start') {
    const entry = path.join(apiDir, 'dist', 'server.js');
    if (!existsSync(entry)) {
      console.error('The API is not built yet. Run "npm run build" first.');
      process.exit(1);
    }
    return run('api', apiDir, [entry, ...extra]);
  }
  const args = API_TASKS[task];
  if (!args) usage();
  return run('api', apiDir, [bin(apiDir, 'tsx/cli'), ...args, ...extra]);
}

function web(task, extra) {
  const args = WEB_TASKS[task];
  if (!args) usage();
  return run('web', webDir, [bin(webDir, 'next/dist/bin/next'), ...args, ...extra]);
}

const children = new Set();
function run(name, cwd, args) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    // If one half of "dev" stops, stop the other so nothing is left running.
    for (const other of children) other.kill();
    if (children.size === 0) process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (err) => {
    console.error(`Could not start ${name}: ${err.message}`);
    process.exit(1);
  });
  return child;
}

function usage() {
  console.error('Usage: node scripts/run.mjs dev | api <dev|start|migrate|seed|create-admin> | web <dev|start|build>');
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => children.forEach((c) => c.kill(sig)));

const missing = [path.join(apiDir, 'package.json'), path.join(webDir, 'package.json')].filter((f) => !existsSync(f));
if (missing.length) {
  console.error(
    `\nThis copy of the project is incomplete. These files are missing:\n  ${missing.join('\n  ')}\n\n` +
      'Extract the whole btbg-platform.zip again into a new folder, move your .env.local into it, then run "npm install".\n',
  );
  process.exit(1);
}

const [target, task, ...extra] = process.argv.slice(2);
const needsEnv = target === 'dev' || target === 'api';
if (!loadEnv() && needsEnv) {
  console.error(
    `\nNo settings file found. Expected one of:\n  ${envFiles.join('\n  ')}\n\n` +
      'Create it by copying .env.example to .env in that folder, then paste your Supabase details into it.\n' +
      '  Windows (cmd):         copy .env.example .env\n' +
      '  Windows (PowerShell):  Copy-Item .env.example .env\n' +
      '  macOS / Linux:         cp .env.example .env\n',
  );
  process.exit(1);
}

if (target === 'dev') {
  api('dev', []);
  web('dev', []);
} else if (target === 'api') api(task, extra);
else if (target === 'web') web(task, extra);
else usage();
