'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { UserPreferences } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';

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
      toast.success(newValue ? 'Email notifications enabled' : 'Email notifications disabled');
    } catch (error) {
      setNotificationEmail(!newValue);
      toast.error(getErrorMessage(error, 'Failed to update notification preference'));
    }
  };

  const handleToggleBudgetDigest = async () => {
    const newValue = !budgetDigestEnabled;
    setBudgetDigestEnabled(newValue);
    try {
      const updated = await userSettingsApi.updatePreferences({ budgetDigestEnabled: newValue });
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(newValue ? 'Budget digest enabled' : 'Budget digest disabled');
    } catch (error) {
      setBudgetDigestEnabled(!newValue);
      toast.error(getErrorMessage(error, 'Failed to update budget digest preference'));
    }
  };

  const handleDigestDayChange = async (day: 'MONDAY' | 'FRIDAY') => {
    const previousDay = budgetDigestDay;
    setBudgetDigestDay(day);
    try {
      const updated = await userSettingsApi.updatePreferences({ budgetDigestDay: day });
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(`Budget digest day set to ${day.charAt(0) + day.slice(1).toLowerCase()}`);
    } catch (error) {
      setBudgetDigestDay(previousDay);
      toast.error(getErrorMessage(error, 'Failed to update digest day'));
    }
  };

  const handleSendTestEmail = async () => {
    setIsSendingTestEmail(true);
    try {
      await userSettingsApi.sendTestEmail();
      toast.success('Test email sent! Check your inbox.');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to send test email'));
    } finally {
      setIsSendingTestEmail(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Notifications</h2>

      {!smtpConfigured ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Email notifications are not available. SMTP has not been configured by the administrator.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Email Notifications</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Receive email reminders for upcoming bills and budget alerts
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
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
                  Budget Notifications
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-700 dark:text-gray-300">Weekly Budget Digest</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Receive a weekly summary of budget alerts and status
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={budgetDigestEnabled}
                      aria-label="Toggle budget digest"
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
                      <p className="text-sm text-gray-600 dark:text-gray-400">Digest day</p>
                      <select
                        value={budgetDigestDay}
                        onChange={(e) => handleDigestDayChange(e.target.value as 'MONDAY' | 'FRIDAY')}
                        aria-label="Budget digest day"
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="MONDAY">Monday</option>
                        <option value="FRIDAY">Friday</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                Critical budget alerts (over budget, income shortfall) are sent immediately regardless of digest settings.
              </p>
            </>
          )}

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Send a test email to verify your notifications are working.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSendTestEmail}
              disabled={isSendingTestEmail || !notificationEmail}
            >
              {isSendingTestEmail ? 'Sending...' : 'Send Test Email'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
