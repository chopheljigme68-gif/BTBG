import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z, type ZodType } from 'zod';
import { authenticate, type AuthContext } from '../middleware/auth.js';
import { badRequest, forbidden, unauthorized } from './errors.js';

/**
 * A tiny routing layer on top of Express that gives every endpoint:
 * - request validation with zod (body, query),
 * - declarative access control (public, any signed-in user, or permissions),
 * - an entry in the generated OpenAPI document (SRS 3.9.7).
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type Access = 'public' | 'optional' | 'user' | { any: string[] };

export interface RouteSpec<B extends ZodType | undefined, Q extends ZodType | undefined> {
  method: Method;
  path: string;
  summary: string;
  access: Access;
  body?: B;
  query?: Q;
  /** multipart/form-data with a single file field named "file". */
  upload?: boolean;
  /** Allow a session that has not finished MFA (used by the MFA endpoints only). */
  allowPendingMfa?: boolean;
}

export interface Ctx<B, Q> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: Record<string, string>;
  auth: AuthContext;
  ip: string | null;
  file?: Express.Multer.File;
}

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export const registry: Array<{ method: Method; path: string; summary: string; tag: string; access: Access; body?: ZodType; query?: ZodType; upload?: boolean }> = [];

const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

export function createModule(prefix: string, tag: string) {
  const router = Router();

  function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined>(
    spec: RouteSpec<B, Q>,
    handler: (ctx: Ctx<Infer<B>, Infer<Q>>) => Promise<unknown>,
  ) {
    registry.push({ ...spec, path: prefix + spec.path, tag });
    const chain: RequestHandler[] = [];
    if (spec.upload) chain.push(uploader.single('file'));
    chain.push(async (req, res) => {
      const auth = await authenticate(req, { allowPendingMfa: spec.allowPendingMfa });
      if (spec.access !== 'public' && spec.access !== 'optional') {
        if (!auth) throw unauthorized();
        if (typeof spec.access === 'object' && !spec.access.any.some((p) => auth.permissions.has(p))) throw forbidden();
      }
      // Multipart fields arrive as strings; a JSON "data" field carries structured values.
      let rawBody = req.body;
      if (spec.upload && typeof req.body?.data === 'string') {
        try {
          rawBody = JSON.parse(req.body.data);
        } catch {
          throw badRequest('The form data could not be read.');
        }
      }
      const body = spec.body ? parse(spec.body, rawBody ?? {}, 'body') : undefined;
      const query = spec.query ? parse(spec.query, req.query, 'query') : undefined;
      const result = await handler({
        req, res, body: body as Infer<B>, query: query as Infer<Q>,
        params: req.params as Record<string, string>,
        auth: auth as AuthContext,
        ip: req.ip ?? null,
        file: req.file,
      });
      if (!res.headersSent) {
        if (result === undefined) res.status(204).end();
        // A POST that returns the new record's id created something (201); other POSTs are actions (200).
        else res.status(spec.method === 'post' && typeof result === 'object' && result !== null && 'id' in result ? 201 : 200).json(result);
      }
    });
    router[spec.method](spec.path, ...chain);
  }

  return { router, route, prefix };
}

function parse<T extends ZodType>(schema: T, data: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const first = fields[0];
    throw badRequest(
      first ? `Please check ${first.field || where}: ${first.message}` : `Invalid ${where}.`,
      { fields },
    );
  }
  return result.data;
}

// Shared zod helpers --------------------------------------------------------
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM');
export const zMobile = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(\+975)?(17|77|16)\d{6}$/, 'enter a Bhutan mobile number, for example 17123456'))
  .transform((s) => (s.startsWith('+975') ? s : `+975${s}`));
export const zMoney = z.coerce.number().min(0).max(10_000_000);
export const zId = z.string().uuid();
export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
});

export function pageClause(p: { page: number; pageSize: number }) {
  return `limit ${p.pageSize} offset ${(p.page - 1) * p.pageSize}`;
}

/** Build an OpenAPI 3.1 document from the route registry. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of registry) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const queryParams = r.query
      ? Object.entries((z.toJSONSchema(r.query, { unrepresentable: 'any', io: 'input' }) as any).properties ?? {}).map(([name, schema]) => ({
          name, in: 'query', required: false, schema,
        }))
      : [];
    paths[p] ??= {};
    paths[p][r.method] = {
      tags: [r.tag],
      summary: r.summary,
      security: r.access === 'public' || r.access === 'optional' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
      ...(typeof r.access === 'object' ? { 'x-permissions': r.access.any } : {}),
      parameters: [...params, ...queryParams],
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: {
                [r.upload ? 'multipart/form-data' : 'application/json']: {
                  schema: r.upload
                    ? { type: 'object', properties: { file: { type: 'string', format: 'binary' }, data: z.toJSONSchema(r.body, { unrepresentable: 'any', io: 'input' }) } }
                    : z.toJSONSchema(r.body, { unrepresentable: 'any', io: 'input' }),
                },
              },
            },
          }
        : {}),
      responses: { 200: { description: 'OK' }, 400: { description: 'Validation error' }, 401: { description: 'Sign in required' }, 403: { description: 'Not permitted' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'BTBG Platform API', version: '1.0.0', description: 'Employer of Record, placement, workforce and career awareness API.' },
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'btbg_session' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}
