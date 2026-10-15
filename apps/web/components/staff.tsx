'use client';
import { useState, type ReactNode } from 'react';
import { Async, Card, Pager, Table, type Column } from '@/components/ui';
import { qs, useApi } from '@/lib/api';

export type Filter = { name: string; label: string; options: Array<{ value: string | number; label: string }> } | { name: string; label: string; type: 'checkbox' };

/**
 * Paged, searchable list used across the back office. The API returns
 * { items, total } for every list endpoint that takes page and pageSize.
 */
export function ListView<T extends Record<string, any>>({ path, columns, filters = [], rowHref, searchPlaceholder = 'Search', initial = {}, empty, pageSize = 25, toolbar }: {
  path: string; columns: Column<T>[]; filters?: Filter[]; rowHref?: (r: T) => string; searchPlaceholder?: string; initial?: Record<string, any>; empty?: ReactNode; pageSize?: number; toolbar?: ReactNode;
}) {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize, ...initial });
  const r = useApi<{ items: T[]; total: number }>(`${path}${qs(q)}`, { keepPreviousData: true });
  const set = (k: string, v: any) => setQ((x) => ({ ...x, [k]: v, page: 1 }));
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-2 border-b border-navy-50 p-3">
        <input className="input max-w-xs py-1.5" type="search" placeholder={searchPlaceholder} aria-label="Search" defaultValue={q.q ?? ''}
          onKeyDown={(e) => { if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value); }} onBlur={(e) => e.target.value !== (q.q ?? '') && set('q', e.target.value)} />
        {filters.map((f) => 'options' in f ? (
          <select key={f.name} className="input w-auto py-1.5 text-sm" aria-label={f.label} value={q[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>
            <option value="">{f.label}: all</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <label key={f.name} className="flex items-center gap-1.5 px-2 text-sm"><input type="checkbox" className="accent-navy-900" checked={Boolean(q[f.name])} onChange={(e) => set(f.name, e.target.checked ? 'true' : '')} />{f.label}</label>
        ))}
        {toolbar && <div className="ml-auto flex gap-2">{toolbar}</div>}
      </div>
      <div className="p-2">
        <Async r={r}>
          {(d) => (
            <>
              <Table rows={d.items} columns={columns} rowHref={rowHref} empty={empty} />
              <Pager page={q.page} pageSize={q.pageSize} total={d.total} onPage={(p) => setQ((x) => ({ ...x, page: p }))} />
            </>
          )}
        </Async>
      </div>
    </Card>
  );
}

export const opts = (values: readonly string[], fmt: (s: string) => string) => values.map((v) => ({ value: v, label: fmt(v) }));
