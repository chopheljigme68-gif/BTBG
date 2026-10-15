'use client';
import Link from 'next/link';
import { useState } from 'react';
import { post } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useApi } from '@/lib/api';
import { Alert, Input, Modal, Select, SubmitButton, Textarea, formData, useAction } from './ui';

/** "Get help" is available on every page, for visitors and signed-in users (FR-HLP-01). */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ ref: string; responseDue: string } | null>(null);
  const me = useApi(open ? '/auth/me' : null, { shouldRetryOnError: false });
  const signedIn = Boolean(me.data);
  const [submit, busy] = useAction(async (body: Record<string, any>) => post('/helpdesk/tickets', { ...body, pageUrl: window.location.pathname }), { onDone: (r) => setDone(r) });

  return (
    <>
      <button onClick={() => { setDone(null); setOpen(true); }}
        className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full bg-gold-500 px-4 py-3 text-sm font-bold text-navy-950 shadow-lg shadow-navy-900/20 transition hover:bg-gold-600 print:hidden"
        aria-label="Get help">
        <span aria-hidden>?</span> Help
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="How can we help?">
        {done ? (
          <div className="space-y-3">
            <Alert tone="ok" title={`Ticket ${done.ref} created`}>We will reply by {dateTime(done.responseDue)}. Keep this reference to track it.</Alert>
            <div className="flex gap-2">
              {signedIn ? <Link href="/app/help" className="btn-primary" onClick={() => setOpen(false)}>View my tickets</Link> : <Link href="/help" className="btn-primary" onClick={() => setOpen(false)}>Track a ticket</Link>}
              <button className="btn-outline" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(formData(e.currentTarget)); }}>
            <p className="text-sm text-slate-600">
              Tell us what is wrong and we will reply by SMS or in the app. To report unfair treatment at work, use <Link className="link" href={signedIn ? '/app/grievances' : '/help#concern'} onClick={() => setOpen(false)}>raise a concern</Link> instead; it is handled confidentially.
            </p>
            <Select name="category" label="Topic" required options={[
              { value: 'account', label: 'My account or signing in' }, { value: 'technical', label: 'Something is not working' },
              { value: 'payment', label: 'Pay or invoices' }, { value: 'placement', label: 'My job or apprentice' }, { value: 'other', label: 'Something else' },
            ]} />
            <Input name="subject" label="Subject" required minLength={3} maxLength={140} />
            <Textarea name="message" label="Message" required minLength={5} />
            {!signedIn && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input name="contactName" label="Your name" />
                <Input name="contactMobile" label="Mobile number" inputMode="tel" placeholder="17xxxxxx" hint="We reply by SMS." />
              </div>
            )}
            <SubmitButton busy={busy} className="btn-primary w-full">Send</SubmitButton>
          </form>
        )}
      </Modal>
    </>
  );
}
