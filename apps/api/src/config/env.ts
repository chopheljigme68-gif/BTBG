import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables.
 * Business rules (wage floor, fees, timers) live in the config_settings table
 * instead, so they can change without a deploy (FR-ADM-10).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),

  // Supabase. DATABASE_URL is the Postgres connection string from
  // Supabase > Project Settings > Database. The URL and service role key are
  // used for file storage.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase Postgres connection string)'),
  DATABASE_SSL: z.enum(['true', 'false']).default('true'),
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('btbg-files'),

  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  FIELD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes, AES-256)'),
  WEBHOOK_SECRET: z.string().min(16).default('change-me-webhook-secret'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),

  // URLs
  WEB_URL: z.string().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),

  // Integrations (adapters fall back to logging providers in development)
  SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
  SMS_HTTP_URL: z.string().optional(),
  SMS_HTTP_TOKEN: z.string().optional(),
  SMS_SENDER_ID: z.string().default('BTBG'),
  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('BTBG <no-reply@btbg.bt>'),

  // Expose OTP codes in API responses so the system can be tried without an
  // SMS gateway. Never enabled in production.
  DEV_EXPOSE_OTP: z.enum(['true', 'false']).default('false'),
  RUN_JOBS: z.enum(['true', 'false']).default('true'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration. See .env.example.\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  databaseSsl: raw.DATABASE_SSL === 'true',
  cookieSecure: raw.COOKIE_SECURE ? raw.COOKIE_SECURE === 'true' : raw.NODE_ENV === 'production',
  exposeOtp: raw.DEV_EXPOSE_OTP === 'true' && raw.NODE_ENV !== 'production',
  runJobs: raw.RUN_JOBS === 'true' && raw.NODE_ENV !== 'test',
  supabaseStorage: Boolean(raw.SUPABASE_URL && raw.SUPABASE_SERVICE_ROLE_KEY),
};
