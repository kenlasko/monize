'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { AppVersion } from '@/components/ui/AppVersion';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { PreferencesSection } from '@/components/settings/PreferencesSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { SecuritySection } from '@/components/settings/SecuritySection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';
import { BackupRestoreSection } from '@/components/settings/BackupRestoreSection';
import { AutoBackupSection } from '@/components/settings/AutoBackupSection';
import { ApiAccessSection } from '@/components/settings/ApiAccessSection';
import { HelpSection } from '@/components/settings/HelpSection';
import { SettingsNav, SettingsSection } from '@/components/settings/SettingsNav';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { User, UserPreferences } from '@/types/auth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useDemoStore } from '@/store/demoStore';
import { useAuthStore } from '@/store/authStore';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import Link from 'next/link';

const logger = createLogger('Settings');

const SETTINGS_SECTION_IDS = [
  { id: 'profile', navKey: 'profile', demoVisible: false },
  { id: 'preferences', navKey: 'preferences', demoVisible: true },
  { id: 'notifications', navKey: 'notifications', demoVisible: true },
  { id: 'security', navKey: 'security', demoVisible: false },
  { id: 'shared-access', navKey: 'sharedAccess', href: '/settings/shared-access', demoVisible: false },
  { id: 'emergency-access', navKey: 'emergencyAccess', href: '/settings/emergency-access', demoVisible: false },
  { id: 'api-access', navKey: 'apiAccess', demoVisible: false },
  { id: 'ai-settings', navKey: 'aiSettings', href: '/settings/ai', demoVisible: false },
  { id: 'backup-restore', navKey: 'backupRestore', demoVisible: false },
  { id: 'auto-backup', navKey: 'autoBackup', demoVisible: false },
  { id: 'help', navKey: 'help', demoVisible: false },
  { id: 'danger-zone', navKey: 'dangerZone', variant: 'danger' as const, demoVisible: false },
] as const;

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <SettingsContent />
    </ProtectedRoute>
  );
}

/**
 * Settings view for an acting delegate. Renders ONLY the Security section
 * so the delegate can manage their own password and 2FA. The fetched
 * profile is the delegate's own (via /auth/me-self), and the 2FA status
 * comes from /auth/2fa/status -- backend security endpoints all operate
 * on req.user.realUserId. Other settings sections are intentionally
 * hidden: they would reflect or alter the owner's account.
 */
function DelegateSecurityView() {
  const t = useTranslations('settings.page');
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [force2fa, setForce2fa] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authApi.getSelfProfile(),
      authApi.get2FAStatus(),
      authApi
        .getAuthMethods()
        .catch(() => ({ force2fa: false } as { force2fa: boolean })),
    ])
      .then(([self, status, methods]) => {
        if (cancelled) return;
        setUser(self as User);
        setTwoFactorEnabled(!!status.enabled);
        setForce2fa(!!methods.force2fa);
      })
      .catch((error) => {
        toast.error(getErrorMessage(error, t('toasts.securityLoadFailed')));
        logger.error(error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

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

  if (!user) {
    return (
      <PageLayout>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader title={t('title')} />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('delegateSecurityError')}
          </p>
        </main>
      </PageLayout>
    );
  }

  // SecuritySection only reads `preferences.twoFactorEnabled` -- supply a
  // minimal stub so it can render without fetching the owner's preferences
  // (which would not be the delegate's own 2FA state anyway).
  const preferencesStub = {
    twoFactorEnabled,
  } as unknown as UserPreferences;

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title={t('title')} />
        <div id="security">
          <SecuritySection
            user={user}
            preferences={preferencesStub}
            force2fa={force2fa}
            onPreferencesUpdated={(next) => {
              if (typeof next.twoFactorEnabled === 'boolean') {
                setTwoFactorEnabled(next.twoFactorEnabled);
              }
            }}
          />
        </div>
      </main>
    </PageLayout>
  );
}

function SettingsContent() {
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  return isDelegateView ? <DelegateSecurityView /> : <OwnerSettingsView />;
}

function OwnerSettingsView() {
  const t = useTranslations('settings.page');
  const tNav = useTranslations('settings.nav');
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [force2fa, setForce2fa] = useState(false);
  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const allSettingsSections = useMemo<readonly (SettingsSection & { demoVisible: boolean })[]>(
    () =>
      SETTINGS_SECTION_IDS.map((s) => ({
        id: s.id,
        label: tNav(s.navKey),
        href: 'href' in s ? s.href : undefined,
        variant: 'variant' in s ? s.variant : undefined,
        demoVisible: s.demoVisible,
      })),
    [tNav],
  );

  const visibleSections = useMemo<readonly SettingsSection[]>(() => {
    if (isDemoMode) {
      return allSettingsSections.filter((s) => s.demoVisible);
    }
    return allSettingsSections;
  }, [isDemoMode, allSettingsSections]);

  const sectionIds = useMemo(
    () => visibleSections.map((s) => s.id),
    [visibleSections],
  );

  const [activeSection, setActiveSection] = useScrollSpy(sectionIds, { enabled: !isLoading });

  const loadData = useCallback(async () => {
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
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        <PageHeader title={t('title')} helpUrl="https://github.com/kenlasko/monize/wiki/Settings-and-Security" />

        {isDemoMode && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('demoRestricted.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('demoRestricted.body')}
            </p>
          </div>
        )}

        {/* Mobile horizontal tabs */}
        <div className="lg:hidden sticky top-[calc(4rem-var(--app-header-offset,0px))] z-10 -mx-4 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 mb-6">
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
            <div className="sticky top-[calc(5.5rem-var(--app-header-offset,0px))]">
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
              <div id="profile" className="scroll-mt-32 lg:scroll-mt-22">
                <ProfileSection
                  user={user}
                  onUserUpdated={setUser}
                />
              </div>
            )}

            {preferences && (
              <div id="preferences" className="scroll-mt-32 lg:scroll-mt-22">
                <PreferencesSection
                  preferences={preferences}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {preferences && (
              <div id="notifications" className="scroll-mt-32 lg:scroll-mt-22">
                <NotificationsSection
                  initialNotificationEmail={preferences.notificationEmail}
                  smtpConfigured={smtpConfigured}
                  preferences={preferences}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {user && preferences && !isDemoMode && (
              <div id="security" className="scroll-mt-32 lg:scroll-mt-22">
                <SecuritySection
                  user={user}
                  preferences={preferences}
                  force2fa={force2fa}
                  onPreferencesUpdated={setPreferences}
                />
              </div>
            )}

            {!isDemoMode && (
              <div id="shared-access" className="scroll-mt-32 lg:scroll-mt-22">
                <Link
                  href="/settings/shared-access"
                  className="block bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    {t('sharedAccessCard.title')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('sharedAccessCard.description')}
                  </p>
                </Link>
              </div>
            )}

            {!isDemoMode && (
              <div id="emergency-access" className="scroll-mt-32 lg:scroll-mt-22">
                <Link
                  href="/settings/emergency-access"
                  className="block bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    {t('emergencyAccessCard.title')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('emergencyAccessCard.description')}
                  </p>
                </Link>
              </div>
            )}

            {!isDemoMode && (
              <div id="api-access" className="scroll-mt-32 lg:scroll-mt-22">
                <ApiAccessSection />
              </div>
            )}

            {!isDemoMode && (
              <div id="ai-settings" className="scroll-mt-32 lg:scroll-mt-22">
                <Link
                  href="/settings/ai"
                  className="block bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    {t('aiSettingsCard.title')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('aiSettingsCard.description')}
                  </p>
                </Link>
              </div>
            )}

            {!isDemoMode && user && (
              <div id="backup-restore" className="scroll-mt-32 lg:scroll-mt-22">
                <BackupRestoreSection user={user} />
              </div>
            )}

            {!isDemoMode && (
              <div id="auto-backup" className="scroll-mt-32 lg:scroll-mt-22">
                <AutoBackupSection />
              </div>
            )}

            <div id="help" className="scroll-mt-32 lg:scroll-mt-22">
              <HelpSection />
            </div>

            {!isDemoMode && user && (
              <div id="danger-zone" className="scroll-mt-32 lg:scroll-mt-22">
                <DangerZoneSection user={user} />
              </div>
            )}

            <AppVersion className="text-center text-xs text-gray-400 dark:text-gray-500 mt-8 mb-4" />
          </div>
        </div>
      </main>
    </PageLayout>
  );
}
