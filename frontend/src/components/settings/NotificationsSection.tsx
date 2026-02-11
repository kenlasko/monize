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
                Receive email reminders for upcoming bills
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
