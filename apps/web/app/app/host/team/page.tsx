'use client';
import { Async, Badge, Card, Input, PageHeader, Select, SubmitButton, Table, formData, useAction } from '@/components/ui';
import { del, post, useApi } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { relative } from '@/lib/format';

/** Host users (FR-EMP-04). */
export default function Team() {
  const r = useApi<any[]>('/host/users');
  const { me } = useMe();
  const [add, busy] = useAction((b: any) => post('/host/users', b), { success: 'Added. They get an SMS with sign-in steps.', onDone: () => r.mutate() });
  const [remove] = useAction((id: string) => del(`/host/users/${id}`), { success: 'Removed', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Team" subtitle="Owners manage everything. Supervisors confirm attendance, do check-ins and review candidates." />
      <Card title="Add a person">
        <form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; if (await add(formData(f))) f.reset(); }}>
          <Input name="fullName" label="Full name" required minLength={2} />
          <Input name="mobile" label="Mobile" required inputMode="tel" />
          <Select name="role" label="Role" options={[{ value: 'host_supervisor', label: 'Supervisor' }, { value: 'host_owner', label: 'Owner' }]} />
          <SubmitButton busy={busy}>Add</SubmitButton>
        </form>
      </Card>
      <Async r={r}>
        {(rows) => (
          <div className="card overflow-hidden">
            <Table rows={rows} columns={[
              { key: 'fullName', label: 'Name' }, { key: 'mobile', label: 'Mobile' },
              { key: 'role', label: 'Role', render: (u) => <Badge tone={u.role === 'host_owner' ? 'gold' : 'blue'}>{u.role === 'host_owner' ? 'Owner' : 'Supervisor'}</Badge> },
              { key: 'lastLoginAt', label: 'Last sign-in', render: (u) => u.lastLoginAt ? relative(u.lastLoginAt) : u.hasPassword ? 'Never' : 'Not set up yet' },
              { key: 'x', label: '', render: (u) => u.id !== me?.user.id && <button className="btn-ghost btn-sm text-red-700" onClick={() => confirm(`Remove ${u.fullName}?`) && remove(u.id)}>Remove</button> },
            ]} />
          </div>
        )}
      </Async>
    </div>
  );
}
