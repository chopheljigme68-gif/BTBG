import { PortalGuard } from '@/components/portal-guard';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <PortalGuard portal="host">{children}</PortalGuard>;
}
