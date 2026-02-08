'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { usePreferencesStore } from '@/store/preferencesStore';

export default function Setup2FAPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { preferences } = usePreferencesStore();

  // If 2FA is already enabled, redirect to dashboard
  useEffect(() => {
    if (preferences?.twoFactorEnabled) {
      router.push('/dashboard');
    }
  }, [preferences, router]);

  if (preferences?.twoFactorEnabled) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            Set Up Two-Factor Authentication
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Two-factor authentication is required by the administrator before you can continue.
          </p>
        </div>

        <TwoFactorSetup
          isForced
          onComplete={() => router.push('/dashboard')}
        />
      </div>
    </div>
  );
}
