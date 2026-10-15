import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { openApiDocument } from './lib/http.js';
import { logger } from './lib/logger.js';
import admin from './modules/admin/routes.js';
import auth from './modules/auth/routes.js';
import billing from './modules/billing/routes.js';
import candidates from './modules/candidates/routes.js';
import careers from './modules/videos/routes.js';
import files from './modules/files/routes.js';
import grievances from './modules/grievances/routes.js';
import helpdesk from './modules/helpdesk/routes.js';
import hosts, { hostsAdmin } from './modules/hosts/routes.js';
import notifications from './modules/notifications/routes.js';
import payroll from './modules/payroll/routes.js';
import placements from './modules/placements/routes.js';
import publicRoutes from './modules/public/routes.js';
import reports from './modules/reports/routes.js';
import seeker from './modules/seeker/routes.js';
import vacancies from './modules/vacancies/routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  // Keep the raw body for webhook signature checks (SRS 3.1.3).
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => ((req as any).rawBody = buf.toString('utf8')) }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // The web app proxies /api/* here, so browsers stay same-origin. Direct API
  // clients (mobile apps, partners) use bearer tokens.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === env.WEB_URL) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.isTest ? 10_000 : 50, standardHeaders: true, legacyHeaders: false });
  app.use('/auth/login', authLimiter);
  app.use('/auth/register', authLimiter);
  app.use('/auth/password', authLimiter);

  app.get('/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument()));

  for (const m of [auth, publicRoutes, admin, candidates, seeker, hosts, hostsAdmin, vacancies, placements, payroll, billing, grievances, helpdesk, careers, notifications, reports, files]) {
    app.use(m.prefix, m.router);
  }

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'This address does not exist.' } }));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    if (pgErr?.code === '23505') {
      return res.status(409).json({ error: { code: 'duplicate', message: 'This record already exists.', details: { constraint: pgErr.constraint } } });
    }
    if (pgErr?.code === '23503') {
      return res.status(400).json({ error: { code: 'invalid_reference', message: 'A linked record does not exist. Refresh and try again.' } });
    }
    if (pgErr?.code === '23514') {
      return res.status(400).json({ error: { code: 'invalid_value', message: 'A value is outside the allowed range.', details: { constraint: pgErr.constraint } } });
    }
    if ((err as any)?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { code: 'file_too_large', message: 'The file is too large.' } });
    }
    logger.error({ err, url: req.url }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'server_error',
        message: 'Something went wrong on our side. Please try again; if it keeps happening, open a help ticket.',
        // Developers see the cause outside production; users never do.
        ...(env.isProd ? {} : { debug: (err as Error)?.message }),
      },
    });
  });

  return app;
}
