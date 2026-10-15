'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Card, Checkbox, Input, Select, SubmitButton, Textarea, useToast } from '@/components/ui';
import { post, put, useApi } from '@/lib/api';

/** Shared create/edit vacancy form (FR-EMP-10). The API enforces the wage floor and legal hours. */
/** With `onSubmitBody`, staff reuse the form (vacancy created on a host's behalf); otherwise it saves through the host portal. */
export function VacancyForm({ initial, id, onSubmitBody }: { initial?: any; id?: string; onSubmitBody?: (body: any) => Promise<void> }) {
  const ref = useApi<any>('/public/reference');
  const careers = useApi<any[]>('/campaign/careers');
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<any>(() => initial ?? { sectorCode: 'hospitality', openings: 1, firstTimeFriendly: true, accommodation: false, meals: false, isSeasonal: false, skillIds: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, val: any) => setV((x: any) => ({ ...x, [k]: val }));
  const num = (x: any) => (x === '' || x === null || x === undefined ? null : Number(x));

  const submit = async (andSubmit: boolean) => {
    setBusy(true); setError(null);
    try {
      const body = {
        title: v.title, department: v.department || null, careerId: v.careerId || null, sectorCode: v.sectorCode, openings: Number(v.openings),
        skillIds: v.skillIds, experienceRequired: v.experienceRequired || null, firstTimeFriendly: v.firstTimeFriendly, dzongkhagId: Number(v.dzongkhagId),
        gewogId: num(v.gewogId), locationText: v.locationText || null, wage: Number(v.wage), accommodation: v.accommodation, meals: v.meals,
        benefits: v.benefits || null, shiftPattern: v.shiftPattern || null, hoursPerWeek: num(v.hoursPerWeek), startDate: v.startDate || null,
        isSeasonal: v.isSeasonal, seasonStart: v.isSeasonal ? v.seasonStart || null : null, seasonEnd: v.isSeasonal ? v.seasonEnd || null : null, description: v.description || null,
      };
      if (onSubmitBody) { await onSubmitBody(body); return; }
      let vid = id;
      if (id) await put(`/host/vacancies/${id}`, body);
      else vid = (await post<{ id: string }>('/host/vacancies', body)).id;
      if (andSubmit) await post(`/host/vacancies/${vid}/submit`);
      toast.ok(andSubmit ? 'Sent to BTBG for review' : 'Saved as draft');
      router.push(`/app/host/vacancies/${vid}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gewogs = ref.data?.gewogs.filter((g: any) => String(g.dzongkhagId) === String(v.dzongkhagId)) ?? [];
  const skills = ref.data?.skills.filter((s: any) => !v.sectorCode || s.sectorCode === v.sectorCode) ?? [];
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
      <Card title="The role">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Job title" required minLength={2} value={v.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Room attendant" />
          <Input label="Department" value={v.department ?? ''} onChange={(e) => set('department', e.target.value)} placeholder="e.g. Housekeeping" />
          <Select label="Sector" value={v.sectorCode} onChange={(e) => set('sectorCode', e.target.value)} options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
          <Select label="Career page (optional)" placeholder="None" value={v.careerId ?? ''} onChange={(e) => set('careerId', e.target.value)} options={careers.data?.map((c) => ({ value: c.id, label: c.title })) ?? []} />
          <Input label="Openings" type="number" min={1} max={100} required value={v.openings ?? 1} onChange={(e) => set('openings', e.target.value)} />
          <Input label="Experience required" value={v.experienceRequired ?? ''} onChange={(e) => set('experienceRequired', e.target.value)} placeholder="None needed" />
        </div>
        <div className="mt-3"><Checkbox label="Suitable for first-time workers" checked={v.firstTimeFriendly} onChange={(e) => set('firstTimeFriendly', e.target.checked)} /></div>
        <p className="label mt-4">Skills needed</p>
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s: any) => {
            const on = v.skillIds.includes(s.id);
            return <button key={s.id} type="button" aria-pressed={on} onClick={() => set('skillIds', on ? v.skillIds.filter((x: number) => x !== s.id) : [...v.skillIds, s.id])}
              className={`rounded-full px-3 py-1 text-xs ring-1 ${on ? 'bg-navy-900 text-white ring-navy-900' : 'bg-white ring-navy-200'}`}>{s.name}</button>;
          })}
        </div>
        <div className="mt-4"><Textarea label="Description" rows={4} maxLength={3000} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} /></div>
      </Card>
      <Card title="Place, pay and hours">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Dzongkhag" required placeholder="Choose" value={v.dzongkhagId ?? ''} onChange={(e) => { set('dzongkhagId', e.target.value); set('gewogId', ''); }} options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
          <Select label="Gewog or thromde" placeholder="Choose" value={v.gewogId ?? ''} onChange={(e) => set('gewogId', e.target.value)} options={gewogs.map((g: any) => ({ value: g.id, label: g.name }))} />
          <Input label="Location details" value={v.locationText ?? ''} onChange={(e) => set('locationText', e.target.value)} />
          <Input label="Monthly wage (Nu)" type="number" min={0} required value={v.wage ?? ''} onChange={(e) => set('wage', e.target.value)} hint="Must meet the training wage floor." />
          <Input label="Hours per week" type="number" min={1} max={72} value={v.hoursPerWeek ?? ''} onChange={(e) => set('hoursPerWeek', e.target.value)} />
          <Input label="Shift pattern" value={v.shiftPattern ?? ''} onChange={(e) => set('shiftPattern', e.target.value)} placeholder="e.g. 7am to 3pm, 6 days" />
          <Input label="Start date" type="date" value={v.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} />
          <Input label="Other benefits" value={v.benefits ?? ''} onChange={(e) => set('benefits', e.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap gap-6">
          <Checkbox label="Accommodation provided" checked={v.accommodation} onChange={(e) => set('accommodation', e.target.checked)} />
          <Checkbox label="Meals provided" checked={v.meals} onChange={(e) => set('meals', e.target.checked)} />
          <Checkbox label="Seasonal role" checked={v.isSeasonal} onChange={(e) => set('isSeasonal', e.target.checked)} />
        </div>
        {v.isSeasonal && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Input label="Season starts" type="date" required value={v.seasonStart ?? ''} onChange={(e) => set('seasonStart', e.target.value)} />
            <Input label="Season ends" type="date" required value={v.seasonEnd ?? ''} onChange={(e) => set('seasonEnd', e.target.value)} />
          </div>
        )}
      </Card>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap gap-3">
        <SubmitButton busy={busy} className="btn-gold">{onSubmitBody ? 'Create and send code to host' : 'Save and send for review'}</SubmitButton>
        {!onSubmitBody && <button type="button" className="btn-outline" disabled={busy} onClick={(e) => { const f = (e.currentTarget.form as HTMLFormElement); if (f.reportValidity()) submit(false); }}>Save as draft</button>}
      </div>
    </form>
  );
}

/** Maps the API's snake_case vacancy row to form state. */
export function vacancyToForm(v: any) {
  return {
    title: v.title, department: v.department, careerId: v.career_id, sectorCode: v.sector_code, openings: v.openings, skillIds: v.skillIds ?? [],
    experienceRequired: v.experience_required, firstTimeFriendly: v.first_time_friendly, dzongkhagId: v.dzongkhag_id, gewogId: v.gewog_id,
    locationText: v.location_text, wage: Number(v.wage), accommodation: v.accommodation, meals: v.meals, benefits: v.benefits, shiftPattern: v.shift_pattern,
    hoursPerWeek: v.hours_per_week, startDate: v.start_date?.slice?.(0, 10) ?? v.start_date, isSeasonal: v.is_seasonal,
    seasonStart: v.season_start?.slice?.(0, 10) ?? v.season_start, seasonEnd: v.season_end?.slice?.(0, 10) ?? v.season_end, description: v.description,
  };
}
