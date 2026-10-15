/** Test configuration. Point TEST_DATABASE_URL at a disposable Postgres database. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/btbg_test',
  DATABASE_SSL: 'false',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
  FIELD_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  WEBHOOK_SECRET: 'test-webhook-secret-123',
  DEV_EXPOSE_OTP: 'true',
  RUN_JOBS: 'false',
  LOCAL_STORAGE_DIR: './storage-test',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  LOG_LEVEL: 'error',
};
