// Fills in JWT_SECRET, FIELD_ENCRYPTION_KEY and WEBHOOK_SECRET in the root .env.local (or .env).
// Only empty or placeholder values are replaced, so running it again never changes a working key.
// With no settings file, it prints the three lines to paste instead.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fresh = {
  JWT_SECRET: () => randomBytes(48).toString('base64url'),
  FIELD_ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
  WEBHOOK_SECRET: () => randomBytes(24).toString('base64url'),
};
const valid = {
  JWT_SECRET: (v) => v.length >= 32 && !v.startsWith('PASTE_'),
  FIELD_ENCRYPTION_KEY: (v) => /^[0-9a-fA-F]{64}$/.test(v),
  WEBHOOK_SECRET: (v) => v.length >= 16 && !v.startsWith('PASTE_'),
};

const file = ['.env.local', '.env'].map((f) => path.join(root, f)).find(existsSync);
if (!file) {
  for (const [key, make] of Object.entries(fresh)) console.log(`${key}=${make()}`);
  process.exit(0);
}

const eol = readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const changed = [];
for (const [key, make] of Object.entries(fresh)) {
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  const current = i < 0 ? '' : lines[i].slice(lines[i].indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (valid[key](current)) continue;
  const line = `${key}=${make()}`;
  if (i < 0) lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  else lines[i] = line;
  changed.push(key);
}
writeFileSync(file, lines.join(eol));
console.log(
  changed.length
    ? `Updated ${changed.join(', ')} in ${file}`
    : `All three secrets in ${file} are already set. Nothing changed.`,
);