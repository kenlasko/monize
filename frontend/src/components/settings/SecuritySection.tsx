'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { BackupCodesDisplay } from '@/components/auth/BackupCodesDisplay';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import { User, UserPreferences, TrustedDevice } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { passwordSchema } from '@/lib/zod-helpers';
import { useDateFormat } from '@/hooks/useDateFormat';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128, 'Password must be 128 characters or less'),
  newPassword: passwordSchema,
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
  const t = useTranslations('settings.security');
  const tc = useTranslations('common');
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const { formatDate } = useDateFormat();

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

  const [showBackupCodes, setShowBackupCodes] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [isGeneratingCodes, setIsGeneratingCodes] = useState(false);
  const [showBackupCodeVerify, setShowBackupCodeVerify] = useState(false);
  const [backupCodeVerifyCode, setBackupCodeVerifyCode] = useState('');

  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false);

  const onSubmitPassword = async (formData: ChangePasswordFormData) => {
    try {
      await userSettingsApi.changePassword({
        currentPassword: formData.currentPassword,
        newPassword: formData.newPassword,
      });
      toast.success(t('toasts.passwordChanged'));
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
      toast.success(t('twoFactor.disableModal.toasts.disabled'));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to disable 2FA'));
    } finally {
      setIsDisabling2FA(false);
    }
  };

  const handleGenerateBackupCodes = async () => {
    if (backupCodeVerifyCode.length !== 6) return;
    setIsGeneratingCodes(true);
    try {
      const response = await authApi.generateBackupCodes(backupCodeVerifyCode);
      setBackupCodes(response.codes);
      setShowBackupCodeVerify(false);
      setBackupCodeVerifyCode('');
      setShowBackupCodes(true);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to generate backup codes'));
    } finally {
      setIsGeneratingCodes(false);
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
    if (twoFactorEnabled && user.hasPassword && user.authProvider !== 'oidc') {
      loadTrustedDevices();
    }
  }, [twoFactorEnabled, user.hasPassword, user.authProvider]);

  const handleRevokeDevice = async (id: string) => {
    try {
      await authApi.revokeTrustedDevice(id);
      setTrustedDevices((prev) => prev.filter((d) => d.id !== id));
      toast.success(t('trustedDevices.toasts.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke device'));
    }
  };

  const handleRevokeAllDevices = async () => {
    try {
      const result = await authApi.revokeAllTrustedDevices();
      setTrustedDevices([]);
      setShowRevokeAllConfirm(false);
      toast.success(t('trustedDevices.toasts.revokedAll', { count: result.count }));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to revoke devices'));
    }
  };

  if (!user.hasPassword) return null;

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('heading')}</h2>
      {user.authProvider === 'oidc' && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t('ssoNotice')}
          </p>
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmitPassword)}>
        <div className="space-y-4">
          <Input
            label={t('currentPasswordLabel')}
            type="password"
            {...register('currentPassword')}
            error={errors.currentPassword?.message}
            placeholder={t('currentPasswordPlaceholder')}
          />
          <div>
            <Input
              label={t('newPasswordLabel')}
              type="password"
              {...register('newPassword')}
              error={errors.newPassword?.message}
              placeholder={t('newPasswordPlaceholder')}
            />
            {!errors.newPassword && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {tc('passwordRequirements')}
              </p>
            )}
          </div>
          <Input
            label={t('confirmPasswordLabel')}
            type="password"
            {...register('confirmPassword')}
            error={errors.confirmPassword?.message}
            placeholder={t('confirmPasswordPlaceholder')}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('changingPasswordButton') : t('changePasswordButton')}
          </Button>
        </div>
      </form>

      {/* Two-Factor Authentication */}
      <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">
          {t('twoFactor.heading')}
        </h3>
        {user.authProvider === 'oidc' ? (
          <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('twoFactor.ssoUnavailable')}
            </p>
          </div>
        ) : (
          <>
            {twoFactorEnabled ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    {t('twoFactor.enabledBadge')}
                  </span>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('twoFactor.enabledDescription')}
                  </p>
                </div>
                {force2fa ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                    {t('twoFactor.requiredByAdmin')}
                  </p>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTwoFactorDisable(true)}
                  >
                    {t('twoFactor.disableButton')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('twoFactor.addLayerDescription')}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setShowTwoFactorSetup(true)}
                >
                  {t('twoFactor.enableButton')}
                </Button>
              </div>
            )}
          </>
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
            {t('twoFactor.disableModal.title')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('twoFactor.disableModal.description')}
          </p>
          <Input
            label={t('twoFactor.disableModal.verificationCodeLabel')}
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
              {isDisabling2FA ? t('twoFactor.disableModal.disablingButton') : t('twoFactor.disableButton')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Backup Code Verification Modal */}
      <Modal isOpen={showBackupCodeVerify} onClose={() => { setShowBackupCodeVerify(false); setBackupCodeVerifyCode(''); }}>
        <div className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('backupCodes.regenerateModal.title')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('backupCodes.regenerateModal.description')}
          </p>
          <Input
            label={t('backupCodes.regenerateModal.verificationCodeLabel')}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={backupCodeVerifyCode}
            onChange={(e) => setBackupCodeVerifyCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
          />
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => { setShowBackupCodeVerify(false); setBackupCodeVerifyCode(''); }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleGenerateBackupCodes}
              disabled={backupCodeVerifyCode.length !== 6 || isGeneratingCodes}
            >
              {isGeneratingCodes ? t('backupCodes.regenerateModal.regeneratingButton') : t('backupCodes.regenerateModal.regenerateButton')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Backup Codes */}
      {twoFactorEnabled && user.authProvider !== 'oidc' && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-md font-medium text-gray-900 dark:text-gray-100">
                {t('backupCodes.heading')}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t('backupCodes.description')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowBackupCodeVerify(true)}
            >
              {t('backupCodes.regenerateButton')}
            </Button>
          </div>
        </div>
      )}

      {/* Backup Codes Modal */}
      <Modal isOpen={showBackupCodes} onClose={() => { setShowBackupCodes(false); setBackupCodes(null); }}>
        <div className="p-6">
          {backupCodes && (
            <BackupCodesDisplay
              codes={backupCodes}
              onDone={() => { setShowBackupCodes(false); setBackupCodes(null); }}
            />
          )}
        </div>
      </Modal>

      {/* Trusted Devices */}
      {twoFactorEnabled && user.authProvider !== 'oidc' && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-md font-medium text-gray-900 dark:text-gray-100">
              {t('trustedDevices.heading')}
            </h3>
            {trustedDevices.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevokeAllConfirm(true)}
              >
                {t('trustedDevices.revokeAllButton')}
              </Button>
            )}
          </div>

          {isLoadingDevices ? (
            <div className="flex justify-center py-4">
              <LoadingSpinner size="sm" fullContainer={false} />
            </div>
          ) : trustedDevices.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('trustedDevices.noDevices')}
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
                          {t('trustedDevices.currentBadge')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                      {device.ipAddress && <p>IP: {device.ipAddress}</p>}
                      <p>
                        Added {formatDate(new Date(device.createdAt))}
                        {' \u00B7 '}
                        Last used {formatDate(new Date(device.lastUsedAt))}
                        {' \u00B7 '}
                        Expires {formatDate(new Date(device.expiresAt))}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRevokeDevice(device.id)}
                    className="ml-3 flex-shrink-0"
                  >
                    {t('trustedDevices.revokeButton')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Revoke All Confirmation Modal */}
          <Modal isOpen={showRevokeAllConfirm} onClose={() => setShowRevokeAllConfirm(false)}>
            <div className="p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('trustedDevices.revokeAllModal.title')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('trustedDevices.revokeAllModal.description')}
              </p>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowRevokeAllConfirm(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={handleRevokeAllDevices}>
                  {t('trustedDevices.revokeAllButton')}
                </Button>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </div>
  );
}
