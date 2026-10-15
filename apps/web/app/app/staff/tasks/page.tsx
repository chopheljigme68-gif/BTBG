'use client';
import { useState } from 'react';
import { PageHeader, Tabs } from '@/components/ui';
import { TaskList } from './task-list';

export default function Tasks() {
  const [scope, setScope] = useState('mine');
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Tasks" subtitle="Follow-ups the system creates for you and your role." />
      <Tabs value={scope} onChange={setScope} tabs={[{ id: 'mine', label: 'Mine and my role' }, { id: 'all', label: 'Everyone' }]} />
      <div className="card p-4"><TaskList key={scope} scope={scope} /></div>
    </div>
  );
}
