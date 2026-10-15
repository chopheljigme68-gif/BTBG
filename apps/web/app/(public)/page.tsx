'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/lib/api';
import { money } from '@/lib/format';
import { JobCard } from '@/components/job-card';

export default function Home() {
  const stats = useApi('/public/stats');
  const careers = useApi<any[]>('/campaign/careers');
  const jobs = useApi<{ items: any[] }>('/vacancies/public?pageSize=4');
  const router = useRouter();
  const [q, setQ] = useState('');
  const s = stats.data;

  return (
    <>
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 pb-14 md:grid-cols-2 md:pt-16">
          <div>
            <p className="mb-3 inline-flex rounded-full bg-gold-100 px-3 py-1 text-xs font-bold tracking-wide text-gold-700 uppercase">Employed by BTBG · Trained on the job</p>
            <h1 className="text-4xl font-extrabold tracking-tight text-navy-950 sm:text-5xl">Your first real job starts here.</h1>
            <p className="mt-4 text-lg text-slate-700">
              BTBG hires you, pays you on time every month, and places you with a verified employer who trains you. No experience needed.
            </p>
            <form className="mt-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/jobs${q ? `?q=${encodeURIComponent(q)}` : ''}`); }}>
              <input className="input flex-1 py-3 text-base" placeholder="Try “housekeeping” or “cook”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" />
              <button className="btn-primary px-6">Search</button>
            </form>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link href="/register" className="btn-gold">Create my free profile</Link>
              <Link href="/employers" className="btn-outline">I want to hire</Link>
            </div>
          </div>
          <div className="relative">
            <div className="absolute -top-10 -right-10 h-72 w-72 rounded-full bg-gold-300/30 blur-3xl" aria-hidden />
            <div className="card relative overflow-hidden p-8 text-center">
              <Image src="/logo.jpg" alt="BTBG, Bey Tsub Bey Gay" width={600} height={315} className="mx-auto w-full max-w-sm mix-blend-multiply" priority />
              <div className="mt-6 grid grid-cols-3 gap-3 text-center">
                {[['Open jobs', s?.openJobs], ['Verified hosts', s?.verifiedHosts], ['Placed', s?.placements]].map(([l, v]) => (
                  <div key={l as string} className="rounded-xl bg-cream p-3">
                    <div className="text-2xl font-extrabold text-navy-900">{v ?? '·'}</div>
                    <div className="text-xs text-slate-600">{l}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white py-14">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-2xl font-bold text-navy-950">How it works</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-4">
            {[
              ['1', 'Create a profile', 'Sign up with your mobile number in two minutes. Add your skills when you can.'],
              ['2', 'Meet BTBG', 'A field officer calls you, checks your fit, and arranges any short training.'],
              ['3', 'Get placed', 'We match you with a verified host. You sign one contract with BTBG on your phone.'],
              ['4', 'Grow', 'Paid monthly, check-ins at 30, 60 and 90 days, and a certificate at the end.'],
            ].map(([n, t, d]) => (
              <div key={n} className="rounded-2xl border border-navy-100 p-5">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-navy-900 font-bold text-gold-300">{n}</div>
                <h3 className="font-semibold text-navy-950">{t}</h3>
                <p className="mt-1 text-sm text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-2xl font-bold text-navy-950">Latest jobs</h2>
          <Link href="/jobs" className="link text-sm">See all jobs</Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {(jobs.data?.items ?? []).map((v) => <JobCard key={v.id} v={v} />)}
          {jobs.data && jobs.data.items.length === 0 && <p className="text-sm text-slate-600">New jobs are added every week. Create a profile to get an SMS when one matches you.</p>}
        </div>
      </section>

      <section className="bg-navy-950 py-14 text-white">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold">Explore careers</h2>
              <p className="mt-1 text-navy-200">Short videos with real Bhutanese workers, in Dzongkha and English.</p>
            </div>
            <Link href="/careers" className="text-sm font-semibold text-gold-300 hover:underline">All careers</Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {(careers.data ?? []).slice(0, 6).map((c) => (
              <Link key={c.id} href={`/careers/${c.slug}`} className="group rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 transition hover:bg-white/10">
                <p className="text-lg font-semibold group-hover:text-gold-300">{c.title}</p>
                <p className="mt-1 line-clamp-2 text-sm text-navy-200">{c.summary}</p>
                <p className="mt-3 text-xs text-gold-300">{c.wageMin ? `${money(c.wageMin)} to ${money(c.wageMax)} a month` : ''} {c.videos ? `· ${c.videos} video(s)` : ''}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
