'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import { User, UserPreferences, TrustedDevice } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128, 'Password must be 128 characters or less'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password must be 128 characters or less'),
  confirmPassword: z.string().min(1, 'Please confirm your new password').max(128, 'Password must be 128 characters or less'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'New passwords do not match',
  path: ['confirmPassword'],
});

type ChangePasswordFormData = z.infer<typeof changePasswordSchema>;

interface SecuritySectionProps {
  user: User;
  preferences: UserPreferences;
  force2fa: boolean;
  onPreferencesUpdated: (prefs: UserPreferences) => void;
}

export function SecuritySection({ user, preferences, force2fa, onPreferencesUpdated }: SecuritySectionProps) {
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordFormData>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const [twoFactorEnabled, setTwoFactorEnabled] = useState(preferences.twoFactorEnabled);
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showTwoFactorDisable, setShowTwoFactorDisable] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [isDisabling2FA, setIsDisabling2FA] = useState(false);

  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false);

  const onSubmitPassword = async (formData: ChangePasswordFormData) => {
    try {
      await userSettingsApi.changePassword({
        currentPassword: formData.currentPassword,
        newPassword: formData.newPassword,
      });
      toast.success('Password changed successfully');
      reset();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to change password'));
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
      const updated = { ...preferences, twoFactorEnabled: false };
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success('Two-factor authentication disabled');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to disable 2FA'));
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
    if (twoFactorEnabled && user.hasPassword) {
      loadTrustedDevices();
    }
  }, [twoFactorEnabled, user.hasPassword]);

  const handleRevokeDevice = async (id: string) => {
    try {
      await authApi.revokeTrustedDevice(id);
      setTrustedDevices((prev) => prev.filter((d) => d.id !== id));
      toast.success('Device revoked');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke device'));
    }
  };

  const handleRevokeAllDevices = async () => {
    try {
      const result = await authApi.revokeAllTrustedDevices();
      setTrustedDevices([]);
      setShowRevokeAllConfirm(false);
      toast.success(`${result.count} device(s) revoked`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke devices'));
    }
  };

  if (!user.hasPassword) return null;

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Security</h2>
      {user.authProvider === 'oidc' && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Your account uses Single Sign-On (SSO) for authentication. The password below is not used for login but can be kept as a backup if SSO is disabled.
          </p>
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmitPassword)}>
        <div className="space-y-4">
          <Input
            label="Current Password"
            type="password"
            {...register('currentPassword')}
            error={errors.currentPassword?.message}
            placeholder="Enter current password"
          />
          <Input
            label="New Password"
            type="password"
            {...register('newPassword')}
            error={errors.newPassword?.message}
            placeholder="Enter new password (min. 8 characters)"
          />
          <Input
            label="Confirm New Password"
            type="password"
            {...register('confirmPassword')}
            error={errors.confirmPassword?.message}
            placeholder="Confirm new password"
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Changing...' : 'Change Password'}
          </Button>
        </div>
      </form>

      {/* Two-Factor Authentication */}
      <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">
          Two-Factor Authentication
        </h3>
        {user.authProvider === 'oidc' && (
          <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              Two-factor authentication only applies to password-based logins. When using Single Sign-On (SSO), authentication security is managed by your identity provider.
            </p>
          </div>
        )}
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
              const updated = { ...preferences, twoFactorEnabled: true };
              onPreferencesUpdated(updated);
              updatePreferencesStore(updated);
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
              <LoadingSpinner size="sm" fullContainer={false} />
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
  );
}
