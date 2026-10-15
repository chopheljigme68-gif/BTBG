'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { mutate } from 'swr';
import { Async, Empty, PageHeader } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { relative } from '@/lib/format';

export default function Notifications() {
  const r = useApi<{ items: any[]; unread: number }>('/notifications');
  useEffect(() => {
    if (r.data?.unread) post('/notifications/read', {}).then(() => mutate('/auth/me'));
  }, [r.data?.unread]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Messages" subtitle="Updates from BTBG. Important ones are also sent by SMS." />
      <Async r={r}>
        {(d) => d.items.length === 0 ? <Empty title="No messages yet" /> : (
          <ul className="card divide-y divide-navy-50">
            {d.items.map((n) => (
              <li key={n.id} className={`p-4 ${!n.readAt ? 'bg-gold-50/50' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-navy-950">{n.subject ?? 'BTBG'}</p>
                  <span className="text-xs whitespace-nowrap text-slate-500">{relative(n.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-sm text-slate-700">{n.body}</p>
                {n.link && <Link href={n.link} className="mt-1 inline-block text-sm link">Open</Link>}
              </li>
            ))}
          </ul>
        )}
      </Async>
    </div>
  );
}
