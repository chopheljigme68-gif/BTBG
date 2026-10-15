'use client';
import { useEffect } from 'react';
import { HelpButton } from './help-button';
import { ToastProvider } from './ui';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Offline shell and faster repeat visits on slow connections (PWA).
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return (
    <ToastProvider>
      {children}
      <HelpButton />
    </ToastProvider>
  );
}
