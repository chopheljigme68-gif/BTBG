'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { label as fmtLabel } from '@/lib/format';

/* ------------------------------------------------------------------------ */
/* Toasts                                                                    */
/* ------------------------------------------------------------------------ */
type Toast = { id: number; kind: 'ok' | 'error'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-md rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${t.kind === 'ok' ? 'bg-navy-900 text-white' : 'bg-red-700 text-white'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (text: string) => push('ok', text),
    error: (e: unknown) => push('error', e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  };
}

/**
 * Run an API action with a busy state, a success toast and friendly errors.
 * Returns [run, busy].
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: { success?: string | ((r: R) => string); onDone?: (r: R) => void } = {}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (...args: A) => {
    setBusy(true);
    try {
      const r = await fn(...args);
      if (opts.success) toast.ok(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onDone?.(r);
      return r;
    } catch (e) {
      toast.error(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy] as const;
}

/* ------------------------------------------------------------------------ */
/* Layout pieces                                                             */
/* ------------------------------------------------------------------------ */
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {back && <Link href={back.href} className="mb-1 inline-block text-sm text-navy-700 hover:underline">← {back.label}</Link>}
        <h1 className="text-2xl font-bold tracking-tight text-navy-950">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '', padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-navy-50 px-5 py-3">
          {title && <h2 className="font-semibold text-navy-900">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'navy', href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'navy' | 'gold' | 'red' | 'green'; href?: string }) {
  const tones = { navy: 'text-navy-900', gold: 'text-gold-700', red: 'text-red-700', green: 'text-emerald-700' };
  const body = (
    <div className="card h-full p-4">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tones[tone]}`}>{value ?? '—'}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="block transition hover:-translate-y-0.5">{body}</Link> : body;
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  blue: 'bg-navy-50 text-navy-800 ring-navy-200',
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  gold: 'bg-gold-50 text-gold-700 ring-gold-300',
};
const STATUS_TONE: Record<string, keyof typeof BADGE> = {
  active: 'green', open: 'green', verified: 'green', paid: 'green', approved: 'green', signed: 'green', published: 'green', passed: 'green', ready: 'green',
  resolved: 'green', closed: 'gray', converted: 'gold', hired: 'green', confirmed: 'green', green: 'green', completed: 'green', delivered: 'green', sent: 'blue',
  pending: 'amber', submitted: 'amber', draft: 'gray', issued: 'blue', part_paid: 'amber', overdue: 'red', rejected: 'red', suspended: 'red', red: 'red', amber: 'amber',
  failed: 'red', withdrawn: 'gray', not_suitable: 'red', not_selected: 'gray', escalated: 'red', new: 'blue', assigned: 'blue', under_review: 'amber',
  resolution_proposed: 'amber', referred: 'gold', ending: 'amber', ended: 'gray', bench: 'amber', offered: 'blue', contracted: 'blue', proposed: 'gray',
  interview: 'blue', shortlisted: 'blue', applied: 'gray', screening: 'amber', screened: 'blue', training: 'blue', placed: 'green', registered: 'gray', contacted: 'blue',
  in_progress: 'blue', awaiting_user: 'amber', pending_signature: 'amber', superseded: 'gray', scheduled: 'blue', review: 'amber', consent_confirmed: 'blue',
  idea: 'gray', filming: 'gray', editing: 'gray', archived: 'gray', paused: 'amber', filled: 'gold', written_off: 'gray', processing: 'amber', urgent: 'red', high: 'amber',
  normal: 'blue', low: 'gray',
};

export function Badge({ children, tone, status }: { children?: ReactNode; tone?: keyof typeof BADGE; status?: string | null }) {
  const t = tone ?? (status ? STATUS_TONE[status] : undefined) ?? 'gray';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${BADGE[t]}`}>{children ?? fmtLabel(status)}</span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-navy-200 bg-white/60 px-6 py-10 text-center">
      <div className="mb-2 text-3xl" aria-hidden>🌱</div>
      <p className="font-semibold text-navy-900">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-slate-600">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" aria-label="Loading" />;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-navy-700">
      <Spinner /> <span className="text-sm">{text}</span>
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {msg} {retry && <button className="ml-2 font-semibold underline" onClick={retry}>Try again</button>}
    </div>
  );
}

/** Renders loading / error / children for an SWR result. */
export function Async<T>({ r, children, empty }: { r: { data?: T; error?: unknown; isLoading?: boolean; mutate?: () => unknown }; children: (data: T) => ReactNode; empty?: ReactNode }) {
  if (r.error) return <ErrorBox error={r.error} retry={() => r.mutate?.()} />;
  if (r.isLoading || r.data === undefined) return <Loading />;
  if (empty && Array.isArray(r.data) && r.data.length === 0) return <>{empty}</>;
  return <>{children(r.data)}</>;
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; title?: string }) {
  const tones = {
    info: 'border-navy-200 bg-navy-50 text-navy-900',
    warn: 'border-gold-300 bg-gold-50 text-gold-700',
    error: 'border-red-200 bg-red-50 text-red-800',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  return (
    <div className={`rounded-lg border p-3 text-sm ${tones[tone]}`} role={tone === 'error' ? 'alert' : undefined}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Forms                                                                     */
/* ------------------------------------------------------------------------ */
export function Field({ label, hint, error, children, required, className = '' }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}{required && <span className="text-red-600"> *</span>}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
    </label>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode };
export function Input({ label, hint, className, required, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} required={required} className={className}>
      <input className="input" required={required} {...rest} />
    </Field>
  );
}

export function Textarea({ label, hint, className, required, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint} required={required} className={className}>
      <textarea className="input min-h-[96px]" required={required} {...rest} />
    </Field>
  );
}

export function Select({ label, hint, options, className, placeholder, required, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode; hint?: ReactNode; options: Array<{ value: string | number; label: string } | string>; placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint} required={required} className={className}>
      <select className="input" required={required} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{fmtLabel(o)}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </Field>
  );
}

export function Checkbox({ label, hint, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-3 py-1">
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-navy-300 accent-navy-900" {...rest} />
      <span className="text-sm">
        <span className="font-medium text-navy-900">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Read a <form> into a plain object. Numbers and checkboxes are converted by
 * input type; empty fields are left out so optional API fields stay unset.
 */
export function formData(form: HTMLFormElement): Record<string, any> {
  const out: Record<string, any> = {};
  for (const el of Array.from(form.elements) as any[]) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.value === '' && !el.multiple) continue;
    else if (el.type === 'number' || el.dataset.number !== undefined) out[el.name] = Number(el.value);
    else if (el.type === 'file') continue;
    else if (el.multiple && el.tagName === 'SELECT') out[el.name] = Array.from(el.selectedOptions as ArrayLike<HTMLOptionElement>).map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function SubmitButton({ busy, children, className = 'btn-primary', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button type="submit" className={className} disabled={busy || rest.disabled} {...rest}>
      {busy && <Spinner className="h-4 w-4" />} {children}
    </button>
  );
}

/** Six-digit SMS code entry (FR-AUTH-02). */
export function OtpInput({ value, onChange, autoFocus = true }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <input
      className="input text-center font-mono text-2xl tracking-[0.5em]"
      inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus={autoFocus}
      value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" aria-label="SMS code"
    />
  );
}

export function DevCode({ code }: { code?: string }) {
  if (!code) return null;
  return <Alert tone="warn" title="Development mode">No SMS gateway is connected, so your code is <b className="font-mono">{code}</b>.</Alert>;
}

export function FilePicker({ label, accept, onFile, busy, hint }: { label: string; accept?: string; onFile: (f: File) => void; busy?: boolean; hint?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={ref} type="file" className="hidden" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <button type="button" className="btn-outline btn-sm" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <Spinner className="h-3.5 w-3.5" /> : '⬆'} {label}
      </button>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Modal, tabs, tables                                                       */
/* ------------------------------------------------------------------------ */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-navy-50 bg-white px-5 py-3">
          <h2 id={id} className="font-semibold text-navy-950">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** A button that opens a modal containing a form. */
export function ModalButton({ label, title, className = 'btn-outline btn-sm', children, wide }: { label: ReactNode; title: ReactNode; className?: string; wide?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} wide={wide}>{open && children(() => setOpen(false))}</Modal>
    </>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ id: string; label: ReactNode; count?: number }>; value: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-navy-100" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition ${value === t.id ? 'border-gold-500 text-navy-950' : 'border-transparent text-slate-500 hover:text-navy-800'}`}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-navy-50 px-1.5 text-xs text-navy-700">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export type Column<T> = { key: string; label: ReactNode; render?: (row: T) => ReactNode; className?: string };

export function Table<T extends Record<string, any>>({ rows, columns, onRow, rowHref, empty = 'Nothing here yet.' }: { rows: T[]; columns: Column<T>[]; onRow?: (row: T) => void; rowHref?: (row: T) => string; empty?: ReactNode }) {
  const router = useRouter();
  if (!rows.length) return <p className="px-1 py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.className}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className={onRow || rowHref ? 'cursor-pointer' : ''} onClick={(e) => { if ((e.target as HTMLElement).closest('a,button,input,select,label')) return; if (rowHref) router.push(rowHref(r)); else onRow?.(r); }}>
              {columns.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-sm text-slate-600">
      <span>{total} result(s)</span>
      <div className="flex items-center gap-2">
        <button className="btn-outline btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span>
        <button className="btn-outline btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.filter(Boolean).map((it, i) => {
        const [k, v] = it as [ReactNode, ReactNode];
        return (
          <div key={i}>
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{k}</dt>
            <dd className="mt-0.5 text-navy-950">{v ?? '—'}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Stars({ value, onChange, size = 'text-2xl' }: { value: number; onChange?: (n: number) => void; size?: string }) {
  return (
    <div className={`flex gap-1 ${size}`} role={onChange ? 'radiogroup' : undefined} aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={`${n <= value ? 'text-gold-500' : 'text-slate-300'} ${onChange ? 'hover:scale-110' : 'cursor-default'} transition`}>★</button>
      ))}
    </div>
  );
}
