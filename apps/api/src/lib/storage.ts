import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { badRequest } from './errors.js';
import { randomToken } from './crypto.js';

/**
 * File storage adapter. Uses a private Supabase Storage bucket when
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, otherwise local disk.
 * Files are always served through the API, which checks access first.
 */
export const UPLOAD_RULES = {
  document: { maxBytes: 10 * 1024 * 1024, types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] },
  image: { maxBytes: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
  video: { maxBytes: 500 * 1024 * 1024, types: ['video/mp4', 'video/quicktime', 'video/webm'] },
  subtitle: { maxBytes: 1024 * 1024, types: ['text/vtt', 'text/plain', 'application/octet-stream'] },
} as const;

export type UploadKind = keyof typeof UPLOAD_RULES;

// Magic numbers, so a renamed executable cannot pass as a PDF or image (NFR-SEC-09).
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 4).toString() === '%PDF',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'video/mp4': (b) => b.subarray(4, 8).toString() === 'ftyp',
  'video/quicktime': (b) => b.subarray(4, 8).toString() === 'ftyp' || b.subarray(4, 8).toString() === 'moov',
  'video/webm': (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  'text/vtt': (b) => b.subarray(0, 6).toString().replace(/^﻿/, '').startsWith('WEBVTT'),
};

/**
 * Validate type and size and scan content. The scan rejects executable
 * payloads and the EICAR test string; plug a ClamAV daemon in here for
 * full antivirus coverage in production.
 */
export function validateUpload(kind: UploadKind, file: { buffer: Buffer; mimetype: string; size: number }) {
  const rule = UPLOAD_RULES[kind];
  if (file.size > rule.maxBytes) throw badRequest(`File is too large. The limit is ${Math.round(rule.maxBytes / 1024 / 1024)} MB.`);
  let mime = file.mimetype;
  if (kind === 'subtitle') mime = 'text/vtt';
  if (!(rule.types as readonly string[]).includes(mime)) throw badRequest(`This file type is not allowed. Use ${rule.types.join(', ')}.`);
  const check = SIGNATURES[mime];
  if (check && !check(file.buffer)) throw badRequest('The file content does not match its type. Please upload the original file.');
  const head = file.buffer.subarray(0, 4096).toString('latin1');
  if (head.startsWith('MZ') || head.startsWith('\x7fELF') || head.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
    throw badRequest('This file was blocked by the security scan.');
  }
  return mime;
}

let supabase: SupabaseClient | null = null;
const client = () => (supabase ??= createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }));
const localRoot = path.resolve(env.LOCAL_STORAGE_DIR);

function safeKey(key: string) {
  const normalized = path.posix.normalize(key).replace(/^\/+/, '');
  if (normalized.startsWith('..')) throw badRequest('Invalid file path.');
  return normalized;
}

export function newKey(folder: string, originalName: string) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  return `${folder}/${new Date().toISOString().slice(0, 7)}/${randomToken(12)}${ext}`;
}

export async function putFile(key: string, data: Buffer, contentType: string): Promise<string> {
  const k = safeKey(key);
  if (env.supabaseStorage) {
    await ensureBucket();
    const { error } = await client().storage.from(env.SUPABASE_STORAGE_BUCKET).upload(k, data, { contentType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  } else {
    const full = path.join(localRoot, k);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  return k;
}

export async function getFile(key: string): Promise<Buffer> {
  const k = safeKey(key);
  if (env.supabaseStorage) {
    const { data, error } = await client().storage.from(env.SUPABASE_STORAGE_BUCKET).download(k);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  return readFile(path.join(localRoot, k));
}

export async function deleteFile(key: string) {
  const k = safeKey(key);
  if (env.supabaseStorage) await client().storage.from(env.SUPABASE_STORAGE_BUCKET).remove([k]);
  else await unlink(path.join(localRoot, k)).catch(() => undefined);
}

/**
 * Create the private bucket if it does not exist yet. Runs once per process and is
 * awaited before the first upload, so scripts like the seed work on a new project too.
 */
let bucketReady: Promise<void> | null = null;
export function ensureBucket(): Promise<void> {
  if (!env.supabaseStorage) return Promise.resolve();
  bucketReady ??= (async () => {
    const bucket = env.SUPABASE_STORAGE_BUCKET;
    const { data } = await client().storage.getBucket(bucket);
    if (data) return;
    const { error } = await client().storage.createBucket(bucket, { public: false });
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(
        `Could not create the storage bucket "${bucket}": ${error.message}. ` +
          'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (it must be the service_role key, not the anon key).',
      );
    }
  })().catch((err) => {
    bucketReady = null; // allow a retry on the next upload
    throw err;
  });
  return bucketReady;
}

export function contentTypeFor(key: string) {
  const ext = path.extname(key).toLowerCase();
  return (
    {
      '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.vtt': 'text/vtt',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}

/** A short-lived direct URL (Supabase only), so large media streams from the CDN with range support. */
export async function signedUrl(key: string, expiresInSeconds = 3600): Promise<string | null> {
  if (!env.supabaseStorage) return null;
  const { data, error } = await client().storage.from(env.SUPABASE_STORAGE_BUCKET).createSignedUrl(safeKey(key), expiresInSeconds);
  if (error) throw new Error(`Could not sign URL: ${error.message}`);
  return data.signedUrl;
}

export function localPath(key: string): string | null {
  return env.supabaseStorage ? null : path.join(localRoot, safeKey(key));
}
