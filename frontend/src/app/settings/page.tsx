'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { PreferencesSection } from '@/components/settings/PreferencesSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { SecuritySection } from '@/components/settings/SecuritySection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';
import { BackupRestoreSection } from '@/components/settings/BackupRestoreSection';
import { AutoBackupSection } from '@/components/settings/AutoBackupSection';
import { ApiAccessSection } from '@/components/settings/ApiAccessSection';
import { SettingsNav, SettingsSection } from '@/components/settings/SettingsNav';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { User, UserPreferences } from '@/types/auth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useDemoStore } from '@/store/demoStore';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import Link from 'next/link';

const logger = createLogger('Settings');

const ALL_SETTINGS_SECTIONS: readonly (SettingsSection & { demoVisible?: boolean })[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'preferences', label: 'Preferences', demoVisible: true },
  { id: 'notifications', label: 'Notifications', demoVisible: true },
  { id: 'security', label: 'Security' },
  { id: 'api-access', label: 'API Access' },
  { id: 'ai-settings', label: 'AI Settings', href: '/settings/ai', badge: 'Beta' },
  { id: 'backup-restore', label: 'Backup & Restore' },
  { id: 'auto-backup', label: 'Automatic Backup' },
  { id: 'danger-zone', label: 'Danger Zone' },
] as const;

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
  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const visibleSections = useMemo<readonly SettingsSection[]>(() => {
    if (isDemoMode) {
      return ALL_SETTINGS_SECTIONS.filter((s) => s.demoVisible);
    }
    return ALL_SETTINGS_SECTIONS;
  }, [isDemoMode]);

  const sectionIds = useMemo(
    () => visibleSections.map((s) => s.id),
    [visibleSections],
  );

  const [activeSection, setActiveSection] = useScrollSpy(sectionIds, { enabled: !isLoading });

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
        authApi.getAuthMethods().catch(() => ({ local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false })),
      ]);
      setUser(userData);
      setPreferences(prefsData);
      setSmtpConfigured(smtpStatus.configured);
      setForce2fa(authMethods.force2fa);
      useDemoStore.getState().setDemoMode(authMethods.demo ?? false);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load settings'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSectionClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      setActiveSection(id);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [setActiveSection]);

  if (isLoading) {
    return (
      <PageLayout>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className="flex justify-center items-center h-64">
            <LoadingSpinner />
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title="Settings" helpUrl="https://github.com/kenlasko/monize/wiki/Settings-and-Security" />

        {isDemoMode && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              Restricted in Demo Mode
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Profile editing, password changes, two-factor authentication, and account deletion are disabled in demo mode.
            </p>
          </div>
        )}

        {/* Mobile horizontal tabs */}
        <div className="lg:hidden sticky top-0 z-10 -mx-4 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 mb-6">
          <SettingsNav
            sections={visibleSections}
            activeSection={activeSection}
            onSectionClick={handleSectionClick}
            variant="horizontal"
          />
        </div>

        <div className="lg:flex lg:gap-10">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block lg:w-52 shrink-0">
            <div className="sticky top-6">
              <SettingsNav
                sections={visibleSections}
                activeSection={activeSection}
                onSectionClick={handleSectionClick}
                variant="vertical"
              />
            </div>
          </aside>

          {/* Content column */}
          <div className="flex-1 min-w-0">
            {user && !isDemoMode && (
              <div id="profile" className="scroll-mt-16 lg:scroll-mt-6">
                <ProfileSection
                  user={user}
                  onUserUpdated={setUser}
                />
              </div>
            )}

            {preferences && (
              <div id="preferences" className="scroll-mt-16 lg:scroll-mt-6">
                <PreferencesSection
                  preferences={preferences}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {preferences && (
              <div id="notifications" className="scroll-mt-16 lg:scroll-mt-6">
                <NotificationsSection
                  initialNotificationEmail={preferences.notificationEmail}
                  smtpConfigured={smtpConfigured}
                  preferences={preferences}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {user && preferences && !isDemoMode && (
              <div id="security" className="scroll-mt-16 lg:scroll-mt-6">
                <SecuritySection
                  user={user}
                  preferences={preferences}
                  force2fa={force2fa}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {!isDemoMode && (
              <div id="api-access" className="scroll-mt-16 lg:scroll-mt-6">
                <ApiAccessSection />
              </div>
            )}

            {!isDemoMode && (
              <div id="ai-settings" className="scroll-mt-16 lg:scroll-mt-6">
                <Link
                  href="/settings/ai"
                  className="block bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1 flex items-center">
                    AI Settings
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                      Beta
                    </span>
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Configure AI providers, manage API keys, and view usage statistics.
                  </p>
                </Link>
              </div>
            )}

            {!isDemoMode && user && (
              <div id="backup-restore" className="scroll-mt-16 lg:scroll-mt-6">
                <BackupRestoreSection user={user} />
              </div>
            )}

            {!isDemoMode && (
              <div id="auto-backup" className="scroll-mt-16 lg:scroll-mt-6">
                <AutoBackupSection />
              </div>
            )}

            {!isDemoMode && user && (
              <div id="danger-zone" className="scroll-mt-16 lg:scroll-mt-6">
                <DangerZoneSection user={user} />
              </div>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-8 mb-4">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </p>
      </main>
    </PageLayout>
  );
}
