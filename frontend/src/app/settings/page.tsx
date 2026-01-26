'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AppHeader } from '@/components/layout/AppHeader';
import { userSettingsApi } from '@/lib/user-settings';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import {
  User,
  UserPreferences,
  UpdateProfileData,
  UpdatePreferencesData,
  ChangePasswordData,
} from '@/types/auth';

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
      const [userData, prefsData] = await Promise.all([
        userSettingsApi.getProfile(),
        userSettingsApi.getPreferences(),
      ]);
      setLocalUser(userData);
      setPreferences(prefsData);

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
      console.error(error);
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

        {/* Security Section - Only for local auth users */}
        {user?.authProvider === 'local' && (
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Security</h2>
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
