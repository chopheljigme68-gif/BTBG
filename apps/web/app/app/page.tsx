'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { homeFor, useMe } from '@/lib/auth';

export default function AppHome() {
  const { me } = useMe();
  const router = useRouter();
  useEffect(() => { if (me) router.replace(homeFor(me.activeRole)); }, [me, router]);
  return <Loading />;
}
