'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { PushDevicesPanel } from './PushDevicesPanel';
import { PushDiagnostics } from './PushDiagnostics';
import { NotificationPreferencesMatrix } from './NotificationPreferencesMatrix';
import { PortfolioAlertControl } from './PortfolioAlertControl';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { UserPreferences } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { CARD_CLASS } from '@/components/ui/Card';

interface NotificationsSectionProps {
  initialNotificationEmail: boolean;
  smtpConfigured: boolean;
  preferences: UserPreferences;
  onPreferencesUpdated: (prefs: UserPreferences) => void;
}

export function NotificationsSection({
  initialNotificationEmail,
  smtpConfigured,
  preferences,
  onPreferencesUpdated,
}: NotificationsSectionProps) {
  const t = useTranslations('settings.notifications');
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const [notificationEmail, setNotificationEmail] = useState(initialNotificationEmail);
  const [budgetDigestEnabled, setBudgetDigestEnabled] = useState(
    preferences.budgetDigestEnabled ?? true,
  );
  const [budgetDigestDay, setBudgetDigestDay] = useState(
    preferences.budgetDigestDay ?? 'MONDAY',
  );
  const [isSendingTestEmail, setIsSendingTestEmail] = useState(false);

  const handleToggleEmailNotifications = async () => {
    const newValue = !notificationEmail;
    setNotificationEmail(newValue);
    try {
      const updated = await userSettingsApi.updatePreferences({ notificationEmail: newValue });
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(newValue ? t('toasts.emailEnabled') : t('toasts.emailDisabled'));
    } catch (error) {
      setNotificationEmail(!newValue);
      toast.error(getErrorMessage(error, t('toasts.emailUpdateFailed')));
    }
  };

  const handleToggleBudgetDigest = async () => {
    const newValue = !budgetDigestEnabled;
    setBudgetDigestEnabled(newValue);
    try {
      const updated = await userSettingsApi.updatePreferences({ budgetDigestEnabled: newValue });
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(newValue ? t('toasts.digestEnabled') : t('toasts.digestDisabled'));
    } catch (error) {
      setBudgetDigestEnabled(!newValue);
      toast.error(getErrorMessage(error, t('toasts.digestUpdateFailed')));
    }
  };

  const handleDigestDayChange = async (day: 'MONDAY' | 'FRIDAY') => {
    const previousDay = budgetDigestDay;
    setBudgetDigestDay(day);
    try {
      const updated = await userSettingsApi.updatePreferences({ budgetDigestDay: day });
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(t('toasts.digestDaySet', { day: day.charAt(0) + day.slice(1).toLowerCase() }));
    } catch (error) {
      setBudgetDigestDay(previousDay);
      toast.error(getErrorMessage(error, t('toasts.digestDayFailed')));
    }
  };

  const handleSendTestEmail = async () => {
    setIsSendingTestEmail(true);
    try {
      await userSettingsApi.sendTestEmail();
      toast.success(t('toasts.testEmailSent'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.testEmailFailed')));
    } finally {
      setIsSendingTestEmail(false);
    }
  };

  return (
    <div
      {...tourAnchor(TOUR_ANCHORS.settingsNotifications)}
      className={`${CARD_CLASS} p-6 mb-6`}
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('heading')}</h2>

      {/* Email and browser push are separate channels, so the SMTP gate below
          covers only the email half. Nesting push inside it hid the whole push
          surface on every deployment that never configured a mail server. */}
      {!smtpConfigured ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('smtpNotConfigured')}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('emailNotificationsTitle')}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('emailNotificationsDescription')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notificationEmail}
              onClick={handleToggleEmailNotifications}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
                notificationEmail ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  notificationEmail ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {notificationEmail && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                  {t('budgetNotificationsHeading')}
                </h3>
                <div className="mt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-700 dark:text-gray-300">{t('weeklyBudgetDigestTitle')}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t('weeklyBudgetDigestDescription')}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={budgetDigestEnabled}
                      aria-label={t('toggleBudgetDigestLabel')}
                      onClick={handleToggleBudgetDigest}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
                        budgetDigestEnabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          budgetDigestEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {budgetDigestEnabled && (
                    <div className="flex items-center justify-between pl-4">
                      <p className="text-sm text-gray-600 dark:text-gray-400">{t('digestDayLabel')}</p>
                      <select
                        value={budgetDigestDay}
                        onChange={(e) => handleDigestDayChange(e.target.value as 'MONDAY' | 'FRIDAY')}
                        aria-label={t('digestDayAriaLabel')}
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="MONDAY">{t('mondayOption')}</option>
                        <option value="FRIDAY">{t('fridayOption')}</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                {t('immediateAlertsNote')}
              </p>
            </>
          )}

          {/* `pb-4` mirrors the `pt-4` every block below carries: without it the
              next section's rule sits flush against the Send Test Email button,
              which reads as a border on the button rather than a divider. */}
          <div className="border-t border-gray-200 pt-4 pb-4 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              {t('sendTestEmailDescription')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSendTestEmail}
              disabled={isSendingTestEmail || !notificationEmail}
            >
              {isSendingTestEmail ? t('sendingTestEmailButton') : t('sendTestEmailButton')}
            </Button>
          </div>
        </div>
      )}

      {/* The channel matrix spans email AND push, so it renders independent of
          the email master switch: push preferences must be reachable when email
          is off or unconfigured (delivery isolation). Its email columns gate on
          `emailAvailable`; its push column gates on a live device. */}
      <NotificationPreferencesMatrix
        emailAvailable={smtpConfigured && notificationEmail}
      />

      <PortfolioAlertControl />

      <PushDevicesPanel />
      <PushDiagnostics />
    </div>
  );
}
