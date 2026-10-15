'use client';
import useSWR, { type SWRConfiguration } from 'swr';

/** Every call goes to /api/*, which Next proxies to the Node API (same origin, cookie session). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; query?: Record<string, unknown>; file?: File | Blob | null; fileName?: string };

export function qs(query?: Record<string, unknown>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.file ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
  if (opts.file) {
    const fd = new FormData();
    fd.append('file', opts.file, opts.fileName ?? (opts.file as File).name ?? 'upload');
    if (opts.body) fd.append('data', JSON.stringify(opts.body));
    init.body = fd;
  } else if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(opts.query)}`, init);
  } catch {
    throw new ApiError(0, 'offline', 'You seem to be offline. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}&expired=1`;
    }
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
export const upload = <T = any>(path: string, file: File, body?: unknown) => api<T>(path, { method: 'POST', file, body });

/** Read data with caching and revalidation. Pass null to skip. */
export function useApi<T = any>(path: string | null, config?: SWRConfiguration) {
  return useSWR<T>(path, (p: string) => api<T>(p), { revalidateOnFocus: false, ...config });
}

/** A same-origin URL for downloads, PDFs and media (the browser sends the session cookie). */
export const fileUrl = (path: string) => `/api${path}`;
