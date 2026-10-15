'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { mutate } from 'swr';
import { post } from '@/lib/api';
import { can, homeFor, useMe, type Me } from '@/lib/auth';
import { Alert, DevCode, Loading, Modal, OtpInput, useAction } from './ui';

type NavItem = { href: string; label: string; icon: string; show?: (me: Me) => boolean };

const SEEKER: NavItem[] = [
  { href: '/app/seeker', label: 'Home', icon: '🏠' },
  { href: '/app/seeker/jobs', label: 'Jobs', icon: '🔎' },
  { href: '/app/seeker/profile', label: 'My profile', icon: '👤' },
  { href: '/app/seeker/contract', label: 'Contract', icon: '📝', show: (m) => m.person?.lifecycle !== 'job_seeker' || m.person?.stage === 'placed' },
  { href: '/app/seeker/placement', label: 'My placement', icon: '🏨', show: (m) => m.person?.lifecycle !== 'job_seeker' },
  { href: '/app/seeker/payslips', label: 'Payslips', icon: '💵', show: (m) => m.person?.lifecycle !== 'job_seeker' },
  { href: '/app/seeker/certificates', label: 'Certificates', icon: '🎓' },
  { href: '/careers', label: 'Explore careers', icon: '🎬' },
  { href: '/app/grievances', label: 'Raise a concern', icon: '🛡️' },
];
const HOST: NavItem[] = [
  { href: '/app/host', label: 'Home', icon: '🏠' },
  { href: '/app/host/vacancies', label: 'Vacancies', icon: '📋' },
  { href: '/app/host/roster', label: 'Apprentices', icon: '👥' },
  { href: '/app/host/attendance', label: 'Attendance', icon: '🗓️' },
  { href: '/app/host/checkins', label: 'Check-ins', icon: '✅' },
  { href: '/app/host/agreements', label: 'Agreements', icon: '📝', show: (m) => can(m, 'host.admin') },
  { href: '/app/host/invoices', label: 'Invoices', icon: '🧾', show: (m) => can(m, 'host.admin') },
  { href: '/app/host/report', label: 'Reports', icon: '📊' },
  { href: '/app/host/profile', label: 'Company profile', icon: '🏢' },
  { href: '/app/host/team', label: 'Team', icon: '🔑', show: (m) => can(m, 'host.admin') },
  { href: '/app/host/concerns', label: 'Concerns', icon: '📣', show: (m) => can(m, 'host.admin') },
  { href: '/app/grievances', label: 'Raise a concern', icon: '🛡️' },
];
const STAFF: NavItem[] = [
  { href: '/app/staff', label: 'Dashboard', icon: '📊', show: (m) => can(m, 'dashboard.view', 'reports.view') },
  { href: '/app/staff/tasks', label: 'My tasks', icon: '✅', show: (m) => can(m, 'tasks.view') },
  { href: '/app/staff/candidates', label: 'Candidates', icon: '🧑‍🎓', show: (m) => can(m, 'candidates.view') },
  { href: '/app/staff/hosts', label: 'Hosts', icon: '🏢', show: (m) => can(m, 'hosts.view') },
  { href: '/app/staff/vacancies', label: 'Vacancies', icon: '📋', show: (m) => can(m, 'vacancies.review', 'matching.manage', 'vacancies.manage_any') },
  { href: '/app/staff/placements', label: 'Placements', icon: '🤝', show: (m) => can(m, 'placements.view') },
  { href: '/app/staff/payroll', label: 'Payroll', icon: '💵', show: (m) => can(m, 'payroll.view') },
  { href: '/app/staff/billing', label: 'Billing', icon: '🧾', show: (m) => can(m, 'billing.view') },
  { href: '/app/staff/grievances', label: 'Grievances', icon: '🛡️', show: (m) => can(m, 'grievances.handle', 'grievances.view_all') },
  { href: '/app/staff/helpdesk', label: 'Helpdesk', icon: '🎧', show: (m) => can(m, 'helpdesk.handle') },
  { href: '/app/staff/campaign', label: 'Video campaign', icon: '🎬', show: (m) => can(m, 'videos.manage', 'videos.review', 'qa.moderate') },
  { href: '/app/staff/reports', label: 'Reports', icon: '📈', show: (m) => can(m, 'reports.view') },
  { href: '/app/staff/admin', label: 'Administration', icon: '⚙️', show: (m) => can(m, 'users.manage', 'config.manage', 'audit.view', 'roles.manage', 'notifications.templates', 'accounts.suspend') },
];

export function navFor(me: Me) {
  const items = me.activeRole === 'job_seeker' ? SEEKER : me.activeRole.startsWith('host_') ? HOST : STAFF;
  return items.filter((i) => !i.show || i.show(me));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, error, isLoading } = useMe();
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (error) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [error, path, router]);
  useEffect(() => setMenu(false), [path]);

  if (isLoading || !me) return <div className="min-h-screen"><Loading text="Opening BTBG…" /></div>;

  const nav = navFor(me);
  const active = (href: string) => (href === homeFor(me.activeRole) ? path === href : path.startsWith(href));
  const sidebar = (
    <nav className="space-y-0.5" aria-label="Sections">
      {nav.map((n) => (
        <Link key={n.href} href={n.href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${active(n.href) ? 'bg-navy-900 text-white' : 'text-navy-900 hover:bg-navy-50'}`}>
          <span aria-hidden className="w-5 text-center">{n.icon}</span>{n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-navy-100 bg-white/95 backdrop-blur print:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm lg:hidden" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>☰</button>
            <Link href={homeFor(me.activeRole)} className="flex items-center gap-2">
              <Image src="/logo-mark.jpg" alt="" width={34} height={34} className="rounded-md mix-blend-multiply" />
              <span className="hidden font-extrabold text-navy-900 sm:inline">BTBG</span>
            </Link>
          </div>
          <div className="flex items-center gap-1.5">
            <RoleSwitcher me={me} />
            <Link href="/app/notifications" className="btn-ghost btn-sm relative" aria-label={`Notifications, ${me.unreadNotifications} unread`}>
              🔔{me.unreadNotifications > 0 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-gold-500 px-1.5 text-[10px] font-bold text-navy-950">{me.unreadNotifications}</span>}
            </Link>
            <Link href="/app/account" className="btn-ghost btn-sm" title="My account">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-gold-300">{me.user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
              <span className="hidden max-w-32 truncate md:inline">{me.user.fullName}</span>
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-[53px] hidden h-[calc(100vh-53px)] w-60 shrink-0 overflow-y-auto border-r border-navy-100 bg-white/60 p-3 lg:block print:hidden">
          {sidebar}
          <div className="mt-4 border-t border-navy-100 pt-3">
            <Link href="/app/help" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-navy-900 hover:bg-navy-50"><span className="w-5 text-center">🎧</span>My help tickets</Link>
            <SignOut />
          </div>
        </aside>
        {menu && (
          <div className="fixed inset-0 z-40 bg-navy-950/40 lg:hidden" onClick={() => setMenu(false)}>
            <aside className="h-full w-72 overflow-y-auto bg-white p-4" onClick={(e) => e.stopPropagation()}>
              {sidebar}
              <div className="mt-4 border-t border-navy-100 pt-3">
                <Link href="/app/help" className="block rounded-lg px-3 py-2 text-sm hover:bg-navy-50">🎧 My help tickets</Link>
                <SignOut />
              </div>
            </aside>
          </div>
        )}
        <main className="min-w-0 flex-1 px-4 py-6 pb-24 sm:px-6 lg:px-8">
          {me.needsContactReconfirm && <ReconfirmBanner />}
          {children}
        </main>
      </div>
    </div>
  );
}

function RoleSwitcher({ me }: { me: Me }) {
  const router = useRouter();
  const [run, busy] = useAction(async (v: string) => {
    const [role, orgId] = v.split('|');
    const r = await post('/auth/switch-role', { role, orgId: orgId || null });
    await mutate(() => true, undefined, { revalidate: true });
    router.push(homeFor(r.role));
  });
  if (me.roles.length < 2) return <span className="hidden rounded-full bg-gold-50 px-2.5 py-1 text-xs font-semibold text-gold-700 sm:inline">{me.roles[0]?.roleName}</span>;
  return (
    <select className="input w-auto max-w-48 py-1 text-xs" disabled={busy} aria-label="Switch role" value={`${me.activeRole}|${me.activeOrgId ?? ''}`} onChange={(e) => run(e.target.value)}>
      {me.roles.map((r) => <option key={`${r.role}|${r.orgId ?? ''}`} value={`${r.role}|${r.orgId ?? ''}`}>{r.roleName}{r.orgName ? ` · ${r.orgName}` : ''}</option>)}
    </select>
  );
}

function SignOut() {
  const router = useRouter();
  return (
    <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
      onClick={async () => { await post('/auth/logout').catch(() => undefined); await mutate(() => true, undefined, { revalidate: false }); router.replace('/login'); }}>
      <span className="w-5 text-center">↩</span>Sign out
    </button>
  );
}

/** FR-AUTH-13: confirm the mobile number every 90 days so BTBG never loses touch. */
function ReconfirmBanner() {
  const { mutate: refresh } = useMe();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<any>(null);
  const [code, setCode] = useState('');
  const [start, starting] = useAction(() => post('/auth/contact/reconfirm/start'), { onDone: (r) => { setSent(r); setOpen(true); } });
  const [finish, finishing] = useAction(() => post('/auth/contact/reconfirm/complete', { code }), { success: 'Thank you. Your number is confirmed.', onDone: () => { setOpen(false); refresh(); } });
  return (
    <div className="mb-5">
      <Alert tone="warn">
        Please confirm your mobile number is still yours. <button className="font-semibold underline" disabled={starting} onClick={() => start()}>Confirm now</button>
      </Alert>
      <Modal open={open} onClose={() => setOpen(false)} title="Confirm your number">
        <div className="space-y-3">
          <p className="text-sm">Enter the code sent to {sent?.sentTo}.</p>
          <DevCode code={sent?.devCode} />
          <OtpInput value={code} onChange={setCode} />
          <button className="btn-primary w-full" disabled={code.length !== 6 || finishing} onClick={() => finish()}>Confirm</button>
        </div>
      </Modal>
    </div>
  );
}
