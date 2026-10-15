import Image from 'next/image';
import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8">
      <Link href="/" className="mb-6" aria-label="BTBG home">
        <Image src="/logo.jpg" alt="BTBG, Bey Tsub Bey Gay" width={240} height={126} className="mix-blend-multiply" priority />
      </Link>
      <main className="w-full max-w-md">{children}</main>
    </div>
  );
}
