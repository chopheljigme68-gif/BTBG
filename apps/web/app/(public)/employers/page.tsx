import Link from 'next/link';

export const metadata = { title: 'Hire an apprentice' };

export default function Employers() {
  const points = [
    ['We employ, you train', 'BTBG is the legal employer. You get a trained, motivated apprentice without hiring paperwork, payroll or compliance work.'],
    ['One monthly invoice', 'Wages, a management fee and a small admin fee, shown separately. Pay by transfer, cash or cheque.'],
    ['Screened candidates', 'Our field officers screen every candidate with a sector scorecard before you see a Trust Profile.'],
    ['Free replacement', 'If it does not work out in the first 90 days, we replace the apprentice at no extra fee.'],
    ['Seasonal help', 'Staff up for peak months and release people in the off-season; BTBG redeploys them.'],
    ['Convert when ready', 'Hire your apprentice directly at the end, with no hidden fees.'],
  ];
  return (
    <div>
      <section className="bg-navy-950 text-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <p className="text-sm font-semibold tracking-wide text-gold-300 uppercase">For host employers</p>
          <h1 className="mt-2 max-w-2xl text-4xl font-extrabold">Reliable young staff, trained in your workplace, employed by BTBG.</h1>
          <p className="mt-4 max-w-2xl text-lg text-navy-200">Post a vacancy in minutes. Once BTBG verifies your business, we shortlist screened candidates and handle contracts, pay and support.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/register?type=host" className="btn-gold">Register your business</Link>
            <Link href="/login" className="btn border border-white/30 text-white hover:bg-white/10">Host sign in</Link>
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-14 sm:grid-cols-2 lg:grid-cols-3">
        {points.map(([t, d]) => (
          <div key={t} className="card p-6">
            <h2 className="font-semibold text-navy-950">{t}</h2>
            <p className="mt-2 text-sm text-slate-600">{d}</p>
          </div>
        ))}
      </section>
      <section className="mx-auto max-w-6xl px-4">
        <div className="card p-6">
          <h2 className="text-xl font-bold text-navy-950">How it works</h2>
          <ol className="mt-4 grid gap-4 md:grid-cols-5">
            {['Register and upload your trade licence', 'BTBG verifies your business', 'Post a vacancy; we review it', 'Interview our shortlist and choose', 'Sign the Host Placement Agreement'].map((s, i) => (
              <li key={s} className="rounded-xl bg-cream p-4 text-sm"><span className="mb-1 block text-2xl font-extrabold text-gold-600">{i + 1}</span>{s}</li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
