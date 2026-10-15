'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Async, Badge, useAction } from '@/components/ui';
import { del, fileUrl, post, useApi } from '@/lib/api';
import { date, label, money } from '@/lib/format';

export default function JobPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const r = useApi<any>(`/vacancies/public/${slug}`);
  const me = useApi<any>('/auth/me', { shouldRetryOnError: false });
  const [apply, applying] = useAction((id: string) => post('/me/applications', { vacancyId: id }), { success: 'Application sent. We will SMS you about next steps.', onDone: () => r.mutate() });
  const [toggleSave] = useAction(async (v: any) => (v.mine?.saved ? del(`/me/saved/${v.id}`) : post(`/me/saved/${v.id}`)), { onDone: () => r.mutate() });

  const share = async (v: any) => {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: v.title, text: `${v.title} at ${v.host}`, url }).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(url);
      alert('Link copied. Share it on WhatsApp, WeChat or Facebook.');
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/jobs" className="text-sm text-navy-700 hover:underline">← All jobs</Link>
      <Async r={r}>
        {(v) => {
          const isSeeker = me.data?.activeRole === 'job_seeker';
          return (
            <article className="mt-3 space-y-6">
              <header className="card p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h1 className="text-3xl font-bold text-navy-950">{v.title}</h1>
                    <p className="mt-1 text-slate-700">{v.host} {v.hostVerified && <Badge tone="green">✓ Verified by BTBG</Badge>} {v.hostStars && <span className="text-gold-600">{'★'.repeat(v.hostStars)}</span>}</p>
                    <p className="mt-1 text-sm text-slate-600">📍 {[v.gewog, v.dzongkhag].filter(Boolean).join(', ') || v.locationText}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-extrabold text-gold-700">{money(v.wage)}</p>
                    <p className="text-xs text-slate-500">per month, paid by BTBG</p>
                  </div>
                </div>
                {v.status !== 'open' && <div className="mt-4"><Alert tone="warn">This job is not taking applications right now.</Alert></div>}
                <div className="mt-5 flex flex-wrap gap-2">
                  {v.mine?.applied ? (
                    <span className="btn bg-emerald-50 text-emerald-800">✓ Applied · {label(v.mine.applicationStage)}</span>
                  ) : isSeeker ? (
                    <button className="btn-gold" disabled={applying || v.status !== 'open'} onClick={() => apply(v.id)}>Apply with one tap</button>
                  ) : me.data ? (
                    <span className="text-sm text-slate-600">Switch to your job seeker role to apply.</span>
                  ) : (
                    <button className="btn-gold" onClick={() => router.push(`/register?next=${encodeURIComponent(`/jobs/${slug}`)}`)}>Apply: create a free profile</button>
                  )}
                  {isSeeker && <button className="btn-outline" onClick={() => toggleSave(v)}>{v.mine?.saved ? '★ Saved' : '☆ Save'}</button>}
                  <button className="btn-outline" onClick={() => share(v)}>Share</button>
                  {!me.data && <Link href={`/login?next=/jobs/${slug}`} className="btn-ghost">I have an account</Link>}
                </div>
              </header>

              <section className="grid gap-4 sm:grid-cols-3">
                {[
                  ['Openings', `${v.openPositions} of ${v.openings}`], ['Start', date(v.startDate)], ['Hours', v.hoursPerWeek ? `${v.hoursPerWeek} a week` : '—'],
                  ['Shifts', v.shiftPattern ?? '—'], ['Housing', v.accommodation ? 'Provided' : 'Not provided'], ['Meals', v.meals ? 'Provided' : 'Not provided'],
                ].map(([k, val]) => (
                  <div key={k} className="card p-4"><p className="text-xs text-slate-500 uppercase">{k}</p><p className="font-semibold text-navy-950">{val}</p></div>
                ))}
              </section>

              <section className="card space-y-4 p-6">
                <h2 className="text-lg font-semibold text-navy-950">About the job</h2>
                <p className="whitespace-pre-line text-slate-700">{v.description ?? 'The host will explain the daily work at interview.'}</p>
                {v.isSeasonal && <p className="text-sm">Seasonal: {date(v.seasonStart)} to {date(v.seasonEnd)}</p>}
                {v.experienceRequired && <p className="text-sm"><b>Experience:</b> {v.experienceRequired}</p>}
                {v.benefits && <p className="text-sm"><b>Benefits:</b> {v.benefits}</p>}
                {v.skills.length > 0 && <div className="flex flex-wrap gap-1.5">{v.skills.map((s: string) => <Badge key={s} tone="blue">{s}</Badge>)}</div>}
                {v.careerSlug && <p className="text-sm">Want to know more about this work? <Link className="link" href={`/careers/${v.careerSlug}`}>Watch the {v.careerTitle} career videos</Link>.</p>}
              </section>

              <section className="card space-y-3 p-6">
                <h2 className="text-lg font-semibold text-navy-950">About {v.host}</h2>
                {v.hostRating && <p className="text-sm text-gold-700">★ {v.hostRating.average} from {v.hostRating.count} apprentices</p>}
                {v.culture && <p className="text-slate-700">{v.culture}</p>}
                {v.hostValues && <p className="text-sm text-slate-600">{v.hostValues}</p>}
                {v.hostPhotos?.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {v.hostPhotos.map((k: string) => <img key={k} src={fileUrl(`/files/org-photo?key=${encodeURIComponent(k)}`)} alt={`Workplace at ${v.host}`} className="aspect-video w-full rounded-lg object-cover" loading="lazy" />)}
                  </div>
                )}
              </section>
              <Alert tone="info" title="How BTBG employment works">
                You sign one employment contract with BTBG, and BTBG pays you on the 25th of every month. If the placement ends early, you stay employed while we find your next host.
              </Alert>
            </article>
          );
        }}
      </Async>
    </div>
  );
}
