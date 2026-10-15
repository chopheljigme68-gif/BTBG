'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { JobCard } from '@/components/job-card';
import { Async, Empty, Pager } from '@/components/ui';
import { qs, useApi } from '@/lib/api';

export default function JobsPage() {
  return <Suspense><Jobs /></Suspense>;
}

function Jobs() {
  const sp = useSearchParams();
  const router = useRouter();
  const params = Object.fromEntries(sp.entries());
  const page = Number(params.page ?? 1);
  const ref = useApi('/public/reference');
  const r = useApi<{ items: any[]; total: number }>(`/vacancies/public${qs({ ...params, pageSize: 20 })}`);
  const set = (k: string, v: string | null) => {
    const next = { ...params, [k]: v ?? '', page: '' };
    router.replace(`/jobs${qs(next)}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold text-navy-950">Find a job</h1>
      <p className="mt-1 text-slate-600">Every job here is with a host verified by BTBG. You are employed and paid by BTBG.</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="card h-fit space-y-4 p-4" aria-label="Filters">
          <form onSubmit={(e) => { e.preventDefault(); set('q', (e.currentTarget.elements.namedItem('q') as HTMLInputElement).value); }}>
            <label className="label" htmlFor="q">Keyword</label>
            <div className="flex gap-2">
              <input id="q" name="q" className="input" defaultValue={params.q ?? ''} placeholder="Role or employer" />
              <button className="btn-primary btn-sm">Go</button>
            </div>
          </form>
          <div>
            <label className="label" htmlFor="sector">Sector</label>
            <select id="sector" className="input" value={params.sector ?? ''} onChange={(e) => set('sector', e.target.value)}>
              <option value="">All sectors</option>
              {ref.data?.sectors.map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dz">Dzongkhag</label>
            <select id="dz" className="input" value={params.dzongkhagId ?? ''} onChange={(e) => set('dzongkhagId', e.target.value)}>
              <option value="">Anywhere in Bhutan</option>
              {ref.data?.dzongkhags.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="wage">Minimum wage (Nu a month)</label>
            <select id="wage" className="input" value={params.wageMin ?? ''} onChange={(e) => set('wageMin', e.target.value)}>
              <option value="">Any</option>
              {[8000, 10000, 12000, 15000, 20000].map((w) => <option key={w} value={w}>{w.toLocaleString('en-IN')}+</option>)}
            </select>
          </div>
          <fieldset className="space-y-1.5 text-sm">
            {[['accommodation', 'Housing provided'], ['firstTime', 'Good for a first job']].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-navy-900" checked={params[k] === 'true'} onChange={(e) => set(k, e.target.checked ? 'true' : null)} /> {l}
              </label>
            ))}
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-navy-900" checked={params.seasonal === 'true'} onChange={(e) => set('seasonal', e.target.checked ? 'true' : null)} /> Seasonal only
            </label>
          </fieldset>
          {Object.values(params).some(Boolean) && <button className="btn-ghost btn-sm w-full" onClick={() => router.replace('/jobs')}>Clear filters</button>}
        </aside>
        <section aria-live="polite">
          <Async r={r}>
            {(d) => d.items.length === 0 ? (
              <Empty title="No jobs match yet">Try fewer filters, or create a profile and set a job alert so we can SMS you when one opens.</Empty>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600">{d.total} job(s)</p>
                <div className="grid gap-4 md:grid-cols-2">{d.items.map((v) => <JobCard key={v.id} v={v} />)}</div>
                <Pager page={page} pageSize={20} total={d.total} onPage={(p) => set('page', String(p))} />
              </>
            )}
          </Async>
        </section>
      </div>
    </div>
  );
}
