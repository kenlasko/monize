'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { authApi } from '@/lib/auth';
import { useDemoStore } from '@/store/demoStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, _hasHydrated } = useAuthStore();
  const { preferences } = usePreferencesStore();
  const [force2fa, setForce2fa] = useState(false);

  useEffect(() => {
    if (_hasHydrated && !isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, isLoading, _hasHydrated, router]);

  // Fetch force2fa setting
  useEffect(() => {
    if (isAuthenticated && user?.hasPassword) {
      authApi.getAuthMethods().then((methods) => {
        setForce2fa(methods.force2fa);
        useDemoStore.getState().setDemoMode(methods.demo ?? false);
      }).catch(() => {});
    }
  }, [isAuthenticated, user?.hasPassword]);

  // Force password change for users with a local password
  useEffect(() => {
    if (
      user?.mustChangePassword &&
      user.hasPassword &&
      pathname !== '/change-password'
    ) {
      router.push('/change-password');
    }
  }, [user, pathname, router]);

  // Force 2FA setup for users with a local password when FORCE_2FA is enabled
  useEffect(() => {
    if (
      force2fa &&
      user?.hasPassword &&
      !user?.mustChangePassword &&
      preferences &&
      !preferences.twoFactorEnabled &&
      pathname !== '/setup-2fa' &&
      pathname !== '/change-password'
    ) {
      router.push('/setup-2fa');
    }
  }, [force2fa, user, preferences, pathname, router]);

  if (!_hasHydrated || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Loading...</h2>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
