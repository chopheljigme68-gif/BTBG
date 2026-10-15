import Link from 'next/link';

export function VideoCard({ v }: { v: any }) {
  const mins = v.durationSeconds ? `${Math.floor(v.durationSeconds / 60)}:${String(v.durationSeconds % 60).padStart(2, '0')}` : null;
  return (
    <Link href={`/careers/videos/${v.id}`} className="card group overflow-hidden transition hover:shadow-md">
      <div className="relative aspect-video bg-navy-900">
        {v.hasThumbnail && <img src={`/api/campaign/videos/${v.id}/thumbnail`} alt="" className="h-full w-full object-cover" loading="lazy" />}
        <span className="absolute inset-0 flex items-center justify-center text-4xl text-white/90 transition group-hover:scale-110" aria-hidden>▶</span>
        {mins && <span className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 text-xs text-white">{mins}</span>}
        {v.kind === 'short' && <span className="absolute top-2 left-2 rounded bg-gold-500 px-1.5 text-xs font-bold text-navy-950">Short</span>}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 font-semibold text-navy-950">{v.title}</p>
        <p className="text-xs text-slate-500">{v.careerTitle} · {v.views} view(s)</p>
      </div>
    </Link>
  );
}
