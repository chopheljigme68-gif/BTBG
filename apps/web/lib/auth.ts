'use client';
import { useApi } from './api';

export type Me = {
  user: { id: string; mobile: string; email: string | null; fullName: string; language: 'en' | 'dz'; mfaEnabled: boolean };
  activeRole: string;
  activeOrgId: string | null;
  isInternal: boolean;
  roles: Array<{ role: string; roleName: string; orgId: string | null; orgName: string | null; orgVerification: string | null }>;
  permissions: string[];
  person: { id: string; stage: string; lifecycle: string } | null;
  needsContactReconfirm: boolean;
  unreadNotifications: number;
};

export function useMe() {
  const r = useApi<Me>('/auth/me', { shouldRetryOnError: false, revalidateOnFocus: true });
  return { ...r, me: r.data };
}

export const can = (me: Me | undefined, ...perms: string[]) => Boolean(me && perms.some((p) => me.permissions.includes(p)));

/** Where each role lands after signing in. */
export function homeFor(role?: string | null) {
  if (role === 'job_seeker') return '/app/seeker';
  if (role === 'host_owner' || role === 'host_supervisor') return '/app/host';
  return '/app/staff';
}
