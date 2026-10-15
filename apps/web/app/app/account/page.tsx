'use client';
import { Async, Card, Checkbox, Input, KeyValue, PageHeader, Select, SubmitButton, Textarea, formData, useAction } from '@/components/ui';
import { api, post, put, useApi } from '@/lib/api';
import { useMe } from '@/lib/auth';

export default function Account() {
  const { me } = useMe();
  const prefs = useApi<any>('/auth/preferences');
  const [savePrefs, saving] = useAction((b: any) => put('/auth/preferences', b), { success: 'Preferences saved', onDone: () => prefs.mutate() });
  const [changePw, changing] = useAction((b: any) => post('/auth/password/change', b), { success: 'Password changed. Other devices were signed out.' });
  const [requestDelete, deleting] = useAction((b: any) => post('/auth/my-data/deletion-request', b), { success: (r: any) => `Request received (ticket ${r.ticketRef}). We will contact you.` });
  const [exportData, exporting] = useAction(async () => {
    const data = await api('/auth/my-data');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'my-btbg-data.json' });
    a.click();
    URL.revokeObjectURL(url);
  });
  if (!me) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="My account" />
      <Card title="Details">
        <KeyValue items={[['Name', me.user.fullName], ['Mobile', me.user.mobile], ['Email', me.user.email], ['Roles', me.roles.map((r) => r.roleName + (r.orgName ? ` (${r.orgName})` : '')).join(', ')]]} />
      </Card>
      <Card title="Messages and language">
        <Async r={prefs}>
          {(p) => (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); savePrefs(formData(e.currentTarget)); }}>
              <Checkbox name="sms" label="SMS" defaultChecked={p.sms} hint="Codes, pay and interview messages always come by SMS." />
              <Checkbox name="email" label="Email" defaultChecked={p.email} />
              <Checkbox name="inApp" label="In the app" defaultChecked={p.inApp} />
              {!me.isInternal && !me.activeRole.startsWith('host_owner') && <Checkbox name="mfaEnabled" label="Ask for an SMS code when I sign in" defaultChecked={p.mfaEnabled} />}
              <Select name="language" label="Language" defaultValue={p.language} options={[{ value: 'en', label: 'English' }, { value: 'dz', label: 'རྫོང་ཁ Dzongkha' }]} className="max-w-xs" />
              <SubmitButton busy={saving}>Save</SubmitButton>
            </form>
          )}
        </Async>
      </Card>
      <Card title="Password">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; if (await changePw(formData(f))) f.reset(); }}>
          <Input name="currentPassword" type="password" label="Current password" autoComplete="current-password" required />
          <Input name="newPassword" type="password" label="New password" autoComplete="new-password" minLength={8} required />
          <div><SubmitButton busy={changing}>Change password</SubmitButton></div>
        </form>
      </Card>
      <Card title="My data">
        <p className="mb-3 text-sm text-slate-600">Download a copy of everything BTBG holds about you, or ask us to delete it. Some records (contracts, payslips) must be kept by law; we explain what we keep.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline" disabled={exporting} onClick={() => exportData()}>Download my data</button>
        </div>
        <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); requestDelete(formData(e.currentTarget)); }}>
          <Textarea name="reason" label="Ask for deletion (optional reason)" />
          <SubmitButton busy={deleting} className="btn-danger">Request deletion</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
