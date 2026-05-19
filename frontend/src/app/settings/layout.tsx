'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

/**
 * Settings sub-pages are owner-only. The root /settings page is also
 * reachable for a delegate, but renders a Security-only view so the
 * delegate can manage their own credentials (password + 2FA). Any deeper
 * settings sub-route (shared-access, ai, etc.) is owner-only and
 * redirects a delegate back to /settings.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const isDelegateView = !!actingAsUserId;
  const isSubRoute = pathname !== '/settings';

  useEffect(() => {
    if (isDelegateView && isSubRoute) {
      router.replace('/settings');
    }
  }, [isDelegateView, isSubRoute, router]);

  if (isDelegateView && isSubRoute) return null;

  return <>{children}</>;
}
