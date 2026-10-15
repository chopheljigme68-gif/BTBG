'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Input, SubmitButton, formData } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

export default function HelpPage() {
  const [ticket, setTicket] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const track = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null); setTicket(null);
    try { setTicket(await api('/helpdesk/tickets/track', { query: formData(e.currentTarget) })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <div>
        <h1 className="text-3xl font-bold text-navy-950">Help and concerns</h1>
        <p className="mt-2 text-slate-600">Use the <b>Help</b> button at the bottom of any page to open a ticket. We reply by SMS or in the app.</p>
      </div>
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-navy-950">Track a ticket</h2>
        <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={track}>
          <Input name="ref" label="Ticket reference" placeholder="T000123" required />
          <Input name="contact" label="Mobile number or email" required />
          <SubmitButton busy={busy}>Track</SubmitButton>
        </form>
        {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
        {ticket && (
          <div className="mt-4 rounded-lg bg-cream p-4 text-sm">
            <p className="font-semibold">{ticket.ref}: {ticket.subject} <Badge status={ticket.status} /></p>
            <p className="text-slate-600">Opened {dateTime(ticket.createdAt)}. First reply due {dateTime(ticket.responseDue)}.</p>
          </div>
        )}
      </section>
      <section id="concern" className="card p-6">
        <h2 className="text-lg font-semibold text-navy-950">Raise a concern about work</h2>
        <p className="mt-2 text-slate-700">If you are treated unfairly, not paid correctly, or feel unsafe at work, tell us. Concerns are confidential and nobody may act against you for raising one.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>In the app: <Link href="/app/grievances" className="link">Raise a concern</Link> (sign in first).</li>
          <li>By SMS: send <b>COMPLAINT</b> followed by your message to the BTBG number.</li>
          <li>By phone: call your BTBG field officer or the helpdesk.</li>
        </ul>
        <p className="mt-3 text-sm text-slate-600">Safety and harassment concerns are treated as urgent: we contact you within 24 hours.</p>
      </section>
    </div>
  );
}
