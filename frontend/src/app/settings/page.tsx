'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { PreferencesSection } from '@/components/settings/PreferencesSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { SecuritySection } from '@/components/settings/SecuritySection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { User, UserPreferences } from '@/types/auth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Settings');

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <SettingsContent />
    </ProtectedRoute>
  );
}

function SettingsContent() {
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [force2fa, setForce2fa] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [userData, prefsData, smtpStatus, authMethods] = await Promise.all([
        userSettingsApi.getProfile(),
        userSettingsApi.getPreferences(),
        userSettingsApi.getSmtpStatus().catch(() => ({ configured: false })),
        authApi.getAuthMethods().catch(() => ({ local: true, oidc: false, registration: true, smtp: false, force2fa: false })),
      ]);
      setUser(userData);
      setPreferences(prefsData);
      setSmtpConfigured(smtpStatus.configured);
      setForce2fa(authMethods.force2fa);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load settings'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <PageLayout>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 py-8">
          <div className="flex justify-center items-center h-64">
            <LoadingSpinner />
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader title="Settings" />

        {user && (
          <ProfileSection
            user={user}
            onUserUpdated={setUser}
          />
        )}

        {preferences && (
          <PreferencesSection
            preferences={preferences}
            onPreferencesUpdated={setPreferences}
          />
        )}

        {preferences && (
          <NotificationsSection
            initialNotificationEmail={preferences.notificationEmail}
            smtpConfigured={smtpConfigured}
            preferences={preferences}
            onPreferencesUpdated={setPreferences}
          />
        )}

        {user && preferences && (
          <SecuritySection
            user={user}
            preferences={preferences}
            force2fa={force2fa}
            onPreferencesUpdated={setPreferences}
          />
        )}

        <DangerZoneSection />
      </main>

      <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-8 mb-4">
        v{process.env.NEXT_PUBLIC_APP_VERSION}
      </p>
    </PageLayout>
  );
}
