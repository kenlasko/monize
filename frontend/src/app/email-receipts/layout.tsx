'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

/**
 * The receipts page is owner-only (the API refuses a delegate session on every
 * route), so a delegate is sent to the dashboard instead of an error page.
 */
export default function EmailReceiptsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);

  useEffect(() => {
    if (isDelegateView) router.replace('/dashboard');
  }, [isDelegateView, router]);

  if (isDelegateView) return null;

  return <>{children}</>;
}
