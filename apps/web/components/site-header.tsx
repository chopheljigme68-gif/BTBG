'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { homeFor } from '@/lib/auth';

const NAV = [
  { href: '/jobs', label: 'Find a job' },
  { href: '/careers', label: 'Explore careers' },
  { href: '/employers', label: 'For employers' },
  { href: '/verify', label: 'Verify a certificate' },
];

export function SiteHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const me = useApi('/auth/me', { shouldRetryOnError: false });
  return (
    <header className="sticky top-0 z-30 border-b border-navy-100/60 bg-cream/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2" aria-label="BTBG home">
          <Image src="/logo-mark.jpg" alt="" width={40} height={40} className="rounded-md mix-blend-multiply" priority />
          <span className="leading-tight">
            <span className="block text-lg font-extrabold tracking-tight text-navy-900">BTBG</span>
            <span className="block text-[10px] font-semibold tracking-[0.2em] text-navy-700 uppercase">Bey Tsub Bey Gay</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`rounded-lg px-3 py-2 text-sm font-medium ${path.startsWith(n.href) ? 'bg-navy-900 text-white' : 'text-navy-900 hover:bg-navy-50'}`}>{n.label}</Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {me.data ? (
            <Link href={homeFor(me.data.activeRole)} className="btn-primary">My BTBG</Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost">Sign in</Link>
              <Link href="/register" className="btn-gold">Join free</Link>
            </>
          )}
        </div>
        <button className="btn-ghost md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menu">☰</button>
      </div>
      {open && (
        <nav className="border-t border-navy-100 bg-cream px-4 py-3 md:hidden" aria-label="Main mobile">
          {NAV.map((n) => <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 font-medium text-navy-900 hover:bg-navy-50">{n.label}</Link>)}
          <div className="mt-2 flex gap-2">
            {me.data ? <Link href={homeFor(me.data.activeRole)} className="btn-primary flex-1">My BTBG</Link> : (
              <>
                <Link href="/login" className="btn-outline flex-1">Sign in</Link>
                <Link href="/register" className="btn-gold flex-1">Join free</Link>
              </>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 bg-navy-950 text-navy-100">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <p className="text-lg font-bold text-white">BTBG · Bey Tsub Bey Gay</p>
          <p className="mt-2 max-w-sm text-sm text-navy-200">
            We employ young Bhutanese, train them, and place them with verified host employers. Hosts pay one monthly invoice; apprentices get a fair contract, on-time pay and support.
          </p>
        </div>
        <div className="text-sm">
          <p className="mb-2 font-semibold text-gold-300">Job seekers</p>
          <ul className="space-y-1.5">
            <li><Link href="/jobs" className="hover:text-white">Find a job</Link></li>
            <li><Link href="/careers" className="hover:text-white">Explore careers</Link></li>
            <li><Link href="/register" className="hover:text-white">Create a profile</Link></li>
          </ul>
        </div>
        <div className="text-sm">
          <p className="mb-2 font-semibold text-gold-300">BTBG</p>
          <ul className="space-y-1.5">
            <li><Link href="/employers" className="hover:text-white">Hire an apprentice</Link></li>
            <li><Link href="/verify" className="hover:text-white">Verify a certificate</Link></li>
            <li><Link href="/help" className="hover:text-white">Help and concerns</Link></li>
            <li><Link href="/privacy" className="hover:text-white">Privacy</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-xs text-navy-300">© {new Date().getFullYear()} BTBG. Made in Bhutan.</div>
    </footer>
  );
}
