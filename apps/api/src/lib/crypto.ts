import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const key = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'hex');

/** AES-256-GCM field encryption for CID, bank details and grievance text (NFR-SEC-02). */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Deterministic keyed hash, used for duplicate detection on encrypted values. */
export function blindIndex(value: string): string {
  return createHmac('sha256', key).update(value.trim().toUpperCase()).digest('hex');
}

export const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

export function mask(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  return `${'•'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const randomDigits = (length: number) =>
  Array.from({ length }, () => randomInt(0, 10)).join('');

/** Short human-friendly code without ambiguous characters. */
export function randomCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => alphabet[randomInt(0, alphabet.length)]).join('');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmac(payload: string, secret = env.WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
