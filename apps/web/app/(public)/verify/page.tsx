'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function VerifyForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  return (
    <div className="mx-auto max-w-lg px-4 py-14">
      <h1 className="text-3xl font-bold text-navy-950">Verify a certificate</h1>
      <p className="mt-2 text-slate-600">Enter the code printed on a BTBG certificate, or scan its QR code.</p>
      <form className="mt-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) router.push(`/verify/${encodeURIComponent(code.trim().toUpperCase())}`); }}>
        <input className="input font-mono uppercase" placeholder="BTBG-XXXXXXXX" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Certificate code" />
        <button className="btn-primary">Verify</button>
      </form>
    </div>
  );
}
