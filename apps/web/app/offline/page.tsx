export const metadata = { title: 'Offline' };

export default function Offline() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <img src="/logo-mark.jpg" alt="" width={72} height={72} className="mb-4 rounded-xl mix-blend-multiply" />
      <h1 className="text-2xl font-bold text-navy-950">You are offline</h1>
      <p className="mt-2 max-w-sm text-slate-600">Check your mobile data or Wi-Fi. Anything you were typing is still on this page when you go back.</p>
    </main>
  );
}
