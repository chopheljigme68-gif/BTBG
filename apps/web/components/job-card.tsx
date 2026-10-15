import Link from 'next/link';
import { money } from '@/lib/format';

export function JobCard({ v }: { v: any }) {
  return (
    <Link href={`/jobs/${v.slug ?? v.id}`} className="card block p-5 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-navy-950">{v.title}</h3>
          <p className="text-sm text-slate-600">{v.host} {v.hostVerified && <span className="ml-1 rounded bg-emerald-50 px-1.5 text-xs font-medium text-emerald-700">✓ Verified</span>}</p>
        </div>
        <span className="rounded-lg bg-gold-50 px-2 py-1 text-sm font-bold whitespace-nowrap text-gold-700">{money(v.wage)}<span className="text-xs font-normal">/mo</span></span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        <span className="rounded-full bg-navy-50 px-2 py-0.5 text-navy-800">📍 {v.dzongkhag ?? v.locationText ?? 'Bhutan'}</span>
        {v.accommodation && <span className="rounded-full bg-navy-50 px-2 py-0.5 text-navy-800">🏠 Housing</span>}
        {v.meals && <span className="rounded-full bg-navy-50 px-2 py-0.5 text-navy-800">🍲 Meals</span>}
        {v.firstTimeFriendly && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">First job friendly</span>}
        {v.isSeasonal && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">Seasonal</span>}
      </div>
    </Link>
  );
}
