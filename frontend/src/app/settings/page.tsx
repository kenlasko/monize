'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AppHeader } from '@/components/layout/AppHeader';
import { Modal } from '@/components/ui/Modal';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import {
  User,
  UserPreferences,
  UpdateProfileData,
  UpdatePreferencesData,
  ChangePasswordData,
  TrustedDevice,
} from '@/types/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Settings');

const DATE_FORMAT_OPTIONS = [
  { value: 'browser', label: 'Use browser locale (auto-detect)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2024-12-31)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (12/31/2024)' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (31/12/2024)' },
  { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY (31-Dec-2024)' },
];

const NUMBER_FORMAT_OPTIONS = [
  { value: 'browser', label: 'Use browser locale (auto-detect)' },
  { value: 'en-US', label: 'English (US) - 1,234.56' },
  { value: 'en-GB', label: 'English (UK) - 1,234.56' },
  { value: 'de-DE', label: 'German - 1.234,56' },
  { value: 'fr-FR', label: 'French - 1 234,56' },
];

const TIMEZONE_OPTIONS = [
  { value: 'browser', label: 'Use browser timezone (auto-detect)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Toronto', label: 'Eastern Time (Canada)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

const THEME_OPTIONS = [
  { value: 'system', label: 'System (follow device setting)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'AUD', label: 'AUD - Australian Dollar' },
  { value: 'JPY', label: 'JPY - Japanese Yen' },
  { value: 'CHF', label: 'CHF - Swiss Franc' },
  { value: 'CNY', label: 'CNY - Chinese Yuan' },
];

export default function SettingsPage() {
  const router = useRouter();
  const { user: authUser, setUser, logout } = useAuthStore();
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const { setTheme: setAppTheme } = useTheme();
  const [isLoading, setIsLoading] = useState(true);
  const [user, setLocalUser] = useState<User | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);

  // Profile form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);

  // Password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Preferences form state
  const [dateFormat, setDateFormat] = useState('browser');
  const [numberFormat, setNumberFormat] = useState('browser');
  const [timezone, setTimezone] = useState('browser');
  const [theme, setTheme] = useState('system');
  const [defaultCurrency, setDefaultCurrency] = useState('USD');
  const [isUpdatingPreferences, setIsUpdatingPreferences] = useState(false);

  // Notifications state
  const [notificationEmail, setNotificationEmail] = useState(true);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [isSendingTestEmail, setIsSendingTestEmail] = useState(false);

  // 2FA state
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showTwoFactorDisable, setShowTwoFactorDisable] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [isDisabling2FA, setIsDisabling2FA] = useState(false);
  const [force2fa, setForce2fa] = useState(false);

  // Trusted devices state
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false);

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

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
      setLocalUser(userData);
      setPreferences(prefsData);
      setSmtpConfigured(smtpStatus.configured);
      setNotificationEmail(prefsData.notificationEmail);
      setTwoFactorEnabled(prefsData.twoFactorEnabled);
      setForce2fa(authMethods.force2fa);

      // Initialize form state
      setFirstName(userData.firstName || '');
      setLastName(userData.lastName || '');
      setEmail(userData.email);

      setDateFormat(prefsData.dateFormat);
      setNumberFormat(prefsData.numberFormat);
      setTimezone(prefsData.timezone);
      setTheme(prefsData.theme);
      setDefaultCurrency(prefsData.defaultCurrency);
    } catch (error) {
      toast.error('Failed to load settings');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingProfile(true);
    try {
      const data: UpdateProfileData = {};
      if (firstName !== (user?.firstName || '')) data.firstName = firstName;
      if (lastName !== (user?.lastName || '')) data.lastName = lastName;
      if (email !== user?.email) data.email = email;

      if (Object.keys(data).length === 0) {
        toast.error('No changes to save');
        return;
      }

      const updatedUser = await userSettingsApi.updateProfile(data);
      setLocalUser(updatedUser);
      setUser(updatedUser); // Update auth store
      toast.success('Profile updated successfully');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update profile');
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }

    setIsChangingPassword(true);
    try {
      await userSettingsApi.changePassword({
        currentPassword,
        newPassword,
      });
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to change password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleUpdatePreferences = async () => {
    setIsUpdatingPreferences(true);
    try {
      const data: UpdatePreferencesData = {
        dateFormat,
        numberFormat,
        timezone,
        theme: theme as 'light' | 'dark' | 'system',
        defaultCurrency,
      };

      const updated = await userSettingsApi.updatePreferences(data);
      setPreferences(updated);
      updatePreferencesStore(updated); // Update the global store
      setAppTheme(theme as 'light' | 'dark' | 'system'); // Update the theme context
      toast.success('Preferences saved');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to save preferences');
    } finally {
      setIsUpdatingPreferences(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      toast.error('Please type DELETE to confirm');
      return;
    }

    setIsDeleting(true);
    try {
      await userSettingsApi.deleteAccount();
      toast.success('Account deleted');
      logout();
      router.push('/login');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to delete account');
      setIsDeleting(false);
    }
  };

  const handleToggleEmailNotifications = async () => {
    const newValue = !notificationEmail;
    setNotificationEmail(newValue);
    try {
      const updated = await userSettingsApi.updatePreferences({ notificationEmail: newValue });
      setPreferences(updated);
      updatePreferencesStore(updated);
      toast.success(newValue ? 'Email notifications enabled' : 'Email notifications disabled');
    } catch (error: any) {
      setNotificationEmail(!newValue);
      toast.error('Failed to update notification preference');
    }
  };

  const handleDisable2FA = async () => {
    if (disableCode.length !== 6) return;
    setIsDisabling2FA(true);
    try {
      await authApi.disable2FA(disableCode);
      setTwoFactorEnabled(false);
      setShowTwoFactorDisable(false);
      setDisableCode('');
      setTrustedDevices([]);
      // Update preferences store
      if (preferences) {
        const updated = { ...preferences, twoFactorEnabled: false };
        setPreferences(updated);
        updatePreferencesStore(updated);
      }
      toast.success('Two-factor authentication disabled');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to disable 2FA');
    } finally {
      setIsDisabling2FA(false);
    }
  };

  const loadTrustedDevices = async () => {
    setIsLoadingDevices(true);
    try {
      const devices = await authApi.getTrustedDevices();
      setTrustedDevices(devices);
    } catch {
      // silently fail - devices section just won't show data
    } finally {
      setIsLoadingDevices(false);
    }
  };

  useEffect(() => {
    if (twoFactorEnabled && user?.hasPassword) {
      loadTrustedDevices();
    }
  }, [twoFactorEnabled, user?.hasPassword]);

  const handleRevokeDevice = async (id: string) => {
    try {
      await authApi.revokeTrustedDevice(id);
      setTrustedDevices((prev) => prev.filter((d) => d.id !== id));
      toast.success('Device revoked');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to revoke device');
    }
  };

  const handleRevokeAllDevices = async () => {
    try {
      const result = await authApi.revokeAllTrustedDevices();
      setTrustedDevices([]);
      setShowRevokeAllConfirm(false);
      toast.success(`${result.count} device(s) revoked`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to revoke devices');
    }
  };

  const handleSendTestEmail = async () => {
    setIsSendingTestEmail(true);
    try {
      await userSettingsApi.sendTestEmail();
      toast.success('Test email sent! Check your inbox.');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to send test email');
    } finally {
      setIsSendingTestEmail(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AppHeader />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-8">Settings</h1>

        {/* Profile Section */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Profile</h2>
          <form onSubmit={handleUpdateProfile}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="First Name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Enter your first name"
              />
              <Input
                label="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Enter your last name"
              />
            </div>
            <div className="mt-4">
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={isUpdatingProfile}>
                {isUpdatingProfile ? 'Saving...' : 'Save Profile'}
              </Button>
            </div>
          </form>
        </div>

        {/* Preferences Section */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Preferences</h2>

          <div className="space-y-4">
            <Select
              label="Theme"
              options={THEME_OPTIONS}
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            />

            <Select
              label="Default Currency"
              options={CURRENCY_OPTIONS}
              value={defaultCurrency}
              onChange={(e) => setDefaultCurrency(e.target.value)}
            />

            <Select
              label="Date Format"
              options={DATE_FORMAT_OPTIONS}
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
            />

            <Select
              label="Number Format"
              options={NUMBER_FORMAT_OPTIONS}
              value={numberFormat}
              onChange={(e) => setNumberFormat(e.target.value)}
            />

            <Select
              label="Timezone"
              options={TIMEZONE_OPTIONS}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </div>

          <div className="mt-6 flex justify-end">
            <Button onClick={handleUpdatePreferences} disabled={isUpdatingPreferences}>
              {isUpdatingPreferences ? 'Saving...' : 'Save Preferences'}
            </Button>
          </div>
        </div>

        {/* Notifications Section */}
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

        {/* Security Section */}
        {user?.hasPassword && (
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Security</h2>
            {user.authProvider === 'oidc' && (
              <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  Your account uses Single Sign-On (SSO) for authentication. The password below is not used for login but can be kept as a backup if SSO is disabled.
                </p>
              </div>
            )}
            <form onSubmit={handleChangePassword}>
              <div className="space-y-4">
                <Input
                  label="Current Password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                />
                <Input
                  label="New Password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password (min. 8 characters)"
                />
                <Input
                  label="Confirm New Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                />
              </div>
              <div className="mt-4 flex justify-end">
                <Button type="submit" disabled={isChangingPassword}>
                  {isChangingPassword ? 'Changing...' : 'Change Password'}
                </Button>
              </div>
            </form>

            {/* Two-Factor Authentication */}
            <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
              <h3 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">
                Two-Factor Authentication
              </h3>
              {twoFactorEnabled ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      Enabled
                    </span>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Your account is protected with TOTP verification.
                    </p>
                  </div>
                  {force2fa ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                      Required by administrator
                    </p>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowTwoFactorDisable(true)}
                    >
                      Disable 2FA
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Add an extra layer of security to your account.
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setShowTwoFactorSetup(true)}
                  >
                    Enable 2FA
                  </Button>
                </div>
              )}
            </div>

            {/* 2FA Setup Modal */}
            <Modal isOpen={showTwoFactorSetup} onClose={() => setShowTwoFactorSetup(false)}>
              <div className="p-6">
                <TwoFactorSetup
                  onComplete={() => {
                    setShowTwoFactorSetup(false);
                    setTwoFactorEnabled(true);
                    if (preferences) {
                      const updated = { ...preferences, twoFactorEnabled: true };
                      setPreferences(updated);
                      updatePreferencesStore(updated);
                    }
                  }}
                  onSkip={() => setShowTwoFactorSetup(false)}
                />
              </div>
            </Modal>

            {/* 2FA Disable Modal */}
            <Modal isOpen={showTwoFactorDisable} onClose={() => { setShowTwoFactorDisable(false); setDisableCode(''); }}>
              <div className="p-6 space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Disable Two-Factor Authentication
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Enter your current 6-digit code to confirm disabling 2FA.
                </p>
                <Input
                  label="Verification Code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                />
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    onClick={() => { setShowTwoFactorDisable(false); setDisableCode(''); }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    onClick={handleDisable2FA}
                    disabled={disableCode.length !== 6 || isDisabling2FA}
                  >
                    {isDisabling2FA ? 'Disabling...' : 'Disable 2FA'}
                  </Button>
                </div>
              </div>
            </Modal>

            {/* Trusted Devices */}
            {twoFactorEnabled && (
              <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-md font-medium text-gray-900 dark:text-gray-100">
                    Trusted Devices
                  </h3>
                  {trustedDevices.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowRevokeAllConfirm(true)}
                    >
                      Revoke All
                    </Button>
                  )}
                </div>

                {isLoadingDevices ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 dark:border-blue-400"></div>
                  </div>
                ) : trustedDevices.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No trusted devices. When you check &quot;Don&apos;t ask again on this browser&quot; during 2FA login, the device will appear here.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {trustedDevices.map((device) => (
                      <div
                        key={device.id}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {device.deviceName}
                            </p>
                            {device.isCurrent && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                                Current
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                            {device.ipAddress && <p>IP: {device.ipAddress}</p>}
                            <p>
                              Added {new Date(device.createdAt).toLocaleDateString()}
                              {' \u00B7 '}
                              Last used {new Date(device.lastUsedAt).toLocaleDateString()}
                              {' \u00B7 '}
                              Expires {new Date(device.expiresAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevokeDevice(device.id)}
                          className="ml-3 flex-shrink-0"
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Revoke All Confirmation Modal */}
                <Modal isOpen={showRevokeAllConfirm} onClose={() => setShowRevokeAllConfirm(false)}>
                  <div className="p-6 space-y-4">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      Revoke All Trusted Devices
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      This will remove all trusted devices. You will need to enter your 2FA code on your next login from any device.
                    </p>
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" onClick={() => setShowRevokeAllConfirm(false)}>
                        Cancel
                      </Button>
                      <Button variant="danger" onClick={handleRevokeAllDevices}>
                        Revoke All
                      </Button>
                    </div>
                  </div>
                </Modal>
              </div>
            )}
          </div>
        )}

        {/* Danger Zone */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 border-2 border-red-200 dark:border-red-800">
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-4">Danger Zone</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Once you delete your account, there is no going back. Please be certain.
          </p>

          {!showDeleteConfirm ? (
            <Button
              variant="danger"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete Account
            </Button>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                Type DELETE to confirm account deletion:
              </p>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Type DELETE"
              />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={handleDeleteAccount}
                  disabled={isDeleting || deleteConfirmText !== 'DELETE'}
                >
                  {isDeleting ? 'Deleting...' : 'Confirm Delete'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirmText('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
