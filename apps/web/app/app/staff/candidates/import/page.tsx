'use client';
import { useState } from 'react';
import { Alert, Badge, Card, FilePicker, PageHeader, Table, useToast } from '@/components/ui';
import { fileUrl, upload } from '@/lib/api';

/** Partner CSV import with a dry run first (FR-CND-02). */
export default function ImportCandidates() {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try { const r = await upload('/candidates/import', file, { dryRun }); setResult(r); if (!dryRun) toast.ok(`${r.summary.ok} candidates imported`); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Import candidates" back={{ href: '/app/staff/candidates', label: 'Candidates' }} subtitle="For TTIs, colleges, De-suung and other partners." />
      <Card>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Download the <a className="link" href={fileUrl('/candidates/import/template')}>CSV template</a> and fill it in. Separate skills with a semicolon.</li>
          <li>Choose the file and check it. Nothing is saved yet.</li>
          <li>Fix any errors, then import. Duplicates by mobile or CID are skipped.</li>
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <FilePicker label={file ? file.name : 'Choose CSV'} accept=".csv,text/csv" onFile={(f) => { setFile(f); setResult(null); }} />
          <button className="btn-outline" disabled={!file || busy} onClick={() => run(true)}>Check file</button>
          <button className="btn-gold" disabled={!file || busy || !result?.dryRun || result.summary.ok === 0} onClick={() => run(false)}>Import {result?.dryRun ? result.summary.ok : ''} rows</button>
        </div>
      </Card>
      {result && (
        <Card title={result.dryRun ? 'Check result (not saved)' : 'Imported'}>
          <Alert tone={result.summary.errors ? 'warn' : 'ok'}>{result.summary.total} rows: {result.summary.ok} ready, {result.summary.duplicates} duplicates, {result.summary.errors} errors.</Alert>
          <div className="mt-3">
            <Table rows={result.results.map((r: any, i: number) => ({ ...r, id: i }))} columns={[
              { key: 'row', label: 'Row', render: (r: any) => r.row ?? r.id + 2 }, { key: 'name', label: 'Name', render: (r: any) => r.name ?? r.fullName ?? r.full_name ?? '—' },
              { key: 'status', label: 'Result', render: (r: any) => <Badge tone={r.status === 'ok' ? 'green' : r.status === 'duplicate' ? 'amber' : 'red'}>{r.status}</Badge> },
              { key: 'message', label: 'Detail', render: (r: any) => r.message ?? r.error ?? r.errors?.join?.('; ') ?? '' },
            ]} />
          </div>
        </Card>
      )}
    </div>
  );
}
