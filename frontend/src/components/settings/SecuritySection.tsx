'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { BackupCodesDisplay } from '@/components/auth/BackupCodesDisplay';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import { User, UserPreferences, TrustedDevice } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { buildPasswordSchema } from '@/lib/zod-helpers';
import { useDateFormat } from '@/hooks/useDateFormat';

const buildChangePasswordSchema = (t: (key: string) => string, tc: (key: string) => string) => z.object({
  currentPassword: z.string().min(1, t('validation.currentPasswordRequired')).max(128, t('validation.passwordMax')),
  newPassword: buildPasswordSchema(tc),
  confirmPassword: z.string().min(1, t('validation.confirmRequired')).max(128, t('validation.passwordMax')),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: t('validation.newPasswordsNoMatch'),
  path: ['confirmPassword'],
});

type ChangePasswordFormData = z.infer<ReturnType<typeof buildChangePasswordSchema>>;

interface SecuritySectionProps {
  user: User;
  preferences: UserPreferences;
  force2fa: boolean;
  /** Instance flag: an SSO account with a local password is treated like a local one for 2FA. */
  oidcPasswordLogin?: boolean;
  onPreferencesUpdated: (prefs: UserPreferences) => void;
}

/**
 * Disabling 2FA takes the two proofs sign-in takes: a 6-digit authenticator
 * code, or one backup code (xxxx-xxxx, consumed). The backup code is how a
 * user whose authenticator codes stopped working -- the server's JWT_SECRET
 * changed under their enrollment -- switches 2FA off and enrolls again.
 */
function normalizeDisableCode(raw: string): string {
  return raw.replace(/[^A-Fa-f0-9-]/g, '').toLowerCase();
}

function isDisableCodeComplete(code: string): boolean {
  return /^(\d{6}|[a-f0-9]{4}-[a-f0-9]{4})$/.test(code);
}

export function SecuritySection({ user, preferences, force2fa, oidcPasswordLogin = false, onPreferencesUpdated }: SecuritySectionProps) {
  const t = useTranslations('settings.security');
  const tc = useTranslations('common');
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const router = useRouter();
  const { formatDate } = useDateFormat();
  // An SSO user stays on the SSO-only view unless the instance lets the local password sign in.
  const ssoOnly = user.authProvider === 'oidc' && !(oidcPasswordLogin && user.hasPassword);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordFormData>({
    resolver: zodResolver(buildChangePasswordSchema(t, tc)),
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

  const [showTwoFactorReset, setShowTwoFactorReset] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [isResetting2FA, setIsResetting2FA] = useState(false);

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
      toast.error(getErrorMessage(error, t('toasts.passwordChangeFailed')));
    }
  };

  const handleDisable2FA = async () => {
    if (!isDisableCodeComplete(disableCode)) return;
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
      toast.error(getErrorMessage(error, t('twoFactor.disableModal.toasts.disableFailed')));
    } finally {
      setIsDisabling2FA(false);
    }
  };

  const closeResetModal = () => {
    setShowTwoFactorReset(false);
    setResetPassword('');
    setResetCode('');
  };

  /**
   * Replace the authenticator: the server clears the secret, the backup codes
   * and the trusted devices, and keeps this session. Enrollment starts at once
   * -- in place, or on /setup-2fa when FORCE_2FA owes one (ProtectedRoute would
   * send the user there anyway once the store says 2FA is off, and that page
   * records the new enrollment before it leaves, so the two cannot loop).
   */
  const handleReset2FA = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!resetPassword || !isDisableCodeComplete(resetCode)) return;
    setIsResetting2FA(true);
    try {
      await authApi.reset2FA(resetPassword, resetCode);
      closeResetModal();
      setTwoFactorEnabled(false);
      setTrustedDevices([]);
      const updated = { ...preferences, twoFactorEnabled: false };
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(t('twoFactor.resetModal.toasts.reset'));
      if (force2fa) {
        router.push('/setup-2fa');
      } else {
        setShowTwoFactorSetup(true);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('twoFactor.resetModal.toasts.resetFailed')));
    } finally {
      setIsResetting2FA(false);
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
      toast.error(getErrorMessage(error, t('backupCodes.toasts.generateFailed')));
    } finally {
      setIsGeneratingCodes(false);
    }
  };

  // Each time the devices are (re)read below, they show as loading from this
  // render on ("info from previous render"), not from inside the effect.
  const canLoadDevices = twoFactorEnabled && user.hasPassword && !ssoOnly;
  const devicesKey = `${twoFactorEnabled}|${user.hasPassword}|${ssoOnly}`;
  const [devicesLoadKey, setDevicesLoadKey] = useState<string | null>(null);
  if (devicesLoadKey !== devicesKey) {
    setDevicesLoadKey(devicesKey);
    if (canLoadDevices) setIsLoadingDevices(true);
  }

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const loadTrustedDevices = () => {
    const run = async () => {
      try {
        const devices = await authApi.getTrustedDevices();
        setTrustedDevices(devices);
      } catch {
        // silently fail - devices section just won't show data
      } finally {
        setIsLoadingDevices(false);
      }
    };
    return run();
  };

  useEffect(() => {
    if (twoFactorEnabled && user.hasPassword && !ssoOnly) {
      loadTrustedDevices();
    }
  }, [twoFactorEnabled, user.hasPassword, ssoOnly]);

  const handleRevokeDevice = async (id: string) => {
    try {
      await authApi.revokeTrustedDevice(id);
      setTrustedDevices((prev) => prev.filter((d) => d.id !== id));
      toast.success(t('trustedDevices.toasts.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('trustedDevices.toasts.revokeFailed')));
    }
  };

  const handleRevokeAllDevices = async () => {
    try {
      const result = await authApi.revokeAllTrustedDevices();
      setTrustedDevices([]);
      setShowRevokeAllConfirm(false);
      toast.success(t('trustedDevices.toasts.revokedAll', { count: result.count }));
    } catch (error) {
      toast.error(getErrorMessage(error, t('trustedDevices.toasts.revokeAllFailed')));
    }
  };

  if (!user.hasPassword) return null;

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('heading')}</h2>
      {user.authProvider === 'oidc' && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {oidcPasswordLogin ? t('ssoPasswordFallbackNotice') : t('ssoNotice')}
          </p>
        </div>
      )}
      {!ssoOnly && (
      <form onSubmit={handleSubmit(onSubmitPassword)}>
        <div className="space-y-4">
          <Input
            label={t('currentPasswordLabel')}
            type="password"
            autoComplete="current-password"
            {...register('currentPassword')}
            error={errors.currentPassword?.message}
            placeholder={t('currentPasswordPlaceholder')}
          />
          <div>
            <Input
              label={t('newPasswordLabel')}
              type="password"
              autoComplete="new-password"
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
            autoComplete="new-password"
            {...register('confirmPassword')}
            error={errors.confirmPassword?.message}
            placeholder={t('confirmPasswordPlaceholder')}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" isLoading={isSubmitting}>
            {t('changePasswordButton')}
          </Button>
        </div>
      </form>
      )}

      {/* Two-Factor Authentication. `id` is the target of the sign-in-by-backup-code
          redirect (`/settings#two-factor`), which useScrollSpy scrolls to. */}
      <div id="two-factor" className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6 scroll-mt-32 lg:scroll-mt-22">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('twoFactor.heading')}
        </h3>
        {ssoOnly ? (
          <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('twoFactor.ssoUnavailable')}
            </p>
          </div>
        ) : (
          <>
            {twoFactorEnabled ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    {t('twoFactor.enabledBadge')}
                  </span>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('twoFactor.enabledDescription')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                  {force2fa && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                      {t('twoFactor.requiredByAdmin')}
                    </p>
                  )}
                  {/* Offered under FORCE_2FA too: replacing an exposed or
                      unusable authenticator is not switching 2FA off. */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTwoFactorReset(true)}
                  >
                    {t('twoFactor.resetButton')}
                  </Button>
                  {!force2fa && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowTwoFactorDisable(true)}
                    >
                      {t('twoFactor.disableButton')}
                    </Button>
                  )}
                </div>
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
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t('twoFactor.disableModal.title')}
            </h2>
            <InfoTooltip text={t('twoFactor.disableModal.description')} usePortal />
          </div>
          <Input
            label={t('twoFactor.disableModal.verificationCodeLabel')}
            type="text"
            autoComplete="one-time-code"
            maxLength={9}
            value={disableCode}
            onChange={(e) => setDisableCode(normalizeDisableCode(e.target.value))}
            placeholder="000000"
          />
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => { setShowTwoFactorDisable(false); setDisableCode(''); }}
            >
              {tc('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleDisable2FA}
              disabled={!isDisableCodeComplete(disableCode) || isDisabling2FA}
            >
              {isDisabling2FA ? t('twoFactor.disableModal.disablingButton') : t('twoFactor.disableButton')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 2FA Reset Modal */}
      <Modal
        isOpen={showTwoFactorReset}
        onClose={closeResetModal}
        title={t('twoFactor.resetModal.title')}
        description={t('twoFactor.resetModal.description')}
        padding="md"
      >
        <form onSubmit={handleReset2FA} className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('twoFactor.resetModal.effect')}
          </p>
          <Input
            label={t('twoFactor.resetModal.passwordLabel')}
            type="password"
            autoComplete="current-password"
            maxLength={128}
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
          />
          <div>
            <Input
              label={t('twoFactor.resetModal.codeLabel')}
              type="text"
              autoComplete="one-time-code"
              maxLength={9}
              value={resetCode}
              onChange={(e) => setResetCode(normalizeDisableCode(e.target.value))}
              placeholder="000000"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('twoFactor.resetModal.codeHint')}
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={closeResetModal}>
              {tc('cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={!resetPassword || !isDisableCodeComplete(resetCode) || isResetting2FA}
            >
              {isResetting2FA ? t('twoFactor.resetModal.resettingButton') : t('twoFactor.resetButton')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Backup Code Verification Modal */}
      <Modal isOpen={showBackupCodeVerify} onClose={() => { setShowBackupCodeVerify(false); setBackupCodeVerifyCode(''); }}>
        <div className="p-6 space-y-4">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('backupCodes.regenerateModal.title')}
          </h2>
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
              {tc('cancel')}
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
      {twoFactorEnabled && !ssoOnly && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                {t('backupCodes.heading')}
                <InfoTooltip text={t('backupCodes.description')} learnMore="twoFactorBackupCodes" />
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
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
      {twoFactorEnabled && !ssoOnly && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
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
                      {device.ipAddress && (
                        <p>{t('trustedDevices.ipAddress', { ip: device.ipAddress })}</p>
                      )}
                      <p>
                        {t('trustedDevices.dates', {
                          added: formatDate(new Date(device.createdAt)),
                          lastUsed: formatDate(new Date(device.lastUsedAt)),
                          expires: formatDate(new Date(device.expiresAt)),
                        })}
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

          <ConfirmDialog
            isOpen={showRevokeAllConfirm}
            title={t('trustedDevices.revokeAllModal.title')}
            message={t('trustedDevices.revokeAllModal.description')}
            confirmLabel={t('trustedDevices.revokeAllButton')}
            variant="danger"
            onConfirm={handleRevokeAllDevices}
            onCancel={() => setShowRevokeAllConfirm(false)}
          />
        </div>
      )}
    </div>
  );
}
