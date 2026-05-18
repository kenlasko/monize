'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import type { DelegateSectionGrants } from '@/lib/delegation';

type Section = keyof DelegateSectionGrants;

/**
 * Client-side UX guard for section-scoped routes. The backend
 * AccountDelegateGuard is the real enforcement; this just keeps a delegate
 * out of a section they were not granted instead of showing an empty/403
 * page. Non-delegates are unaffected.
 *
 * While acting but before /auth/contexts has resolved (delegateSections
 * still null), render nothing rather than redirecting -- a premature
 * redirect would eject a delegate who actually has the grant.
 */
export function DelegateSectionGuard({
  section,
  children,
}: {
  section: Section;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const delegateSections = useAuthStore((s) => s.delegateSections);
  const isDelegateView = !!actingAsUserId;
  const blocked =
    isDelegateView &&
    delegateSections !== null &&
    !delegateSections[section];

  useEffect(() => {
    if (blocked) {
      router.replace('/dashboard');
    }
  }, [blocked, router]);

  if (isDelegateView && delegateSections === null) return null;
  if (blocked) return null;

  return <>{children}</>;
}
