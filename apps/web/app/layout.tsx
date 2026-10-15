import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'BTBG · Bey Tsub Bey Gay', template: '%s · BTBG' },
  description: 'BTBG employs young Bhutanese, trains them and places them with verified host employers. Find a job, hire an apprentice, or explore careers.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/favicon.png', apple: '/apple-touch-icon.png' },
  applicationName: 'BTBG',
};

export const viewport: Viewport = { themeColor: '#0A2C5C', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
