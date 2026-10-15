'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { homeFor, useMe } from '@/lib/auth';

/** Sends people who open another portal's address (for example a host on a staff link) to their own home. */
export function PortalGuard({ portal, children }: { portal: 'seeker' | 'host' | 'staff'; children: React.ReactNode }) {
  const { me } = useMe();
  const router = useRouter();
  const home = me ? homeFor(me.activeRole) : null;
  const allowed = !home || home === `/app/${portal}`;
  useEffect(() => { if (home && !allowed) router.replace(home); }, [home, allowed, router]);
  return allowed ? <>{children}</> : <Loading text="Opening your home page…" />;
}
