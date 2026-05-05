'use client';

import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { BackupCodesDisplay } from '@/components/auth/BackupCodesDisplay';
import { authApi } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { TwoFactorSetupResponse } from '@/types/auth';

const totpCodeSchema = z.object({
  code: z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

type TotpCodeFormData = z.infer<typeof totpCodeSchema>;

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Password is required').max(128),
});

type PasswordFormData = z.infer<typeof passwordSchema>;

interface TwoFactorSetupProps {
  onComplete: () => void;
  onSkip?: () => void;
  isForced?: boolean;
}

export function TwoFactorSetup({ onComplete, onSkip, isForced }: TwoFactorSetupProps) {
  const [setupData, setSetupData] = useState<TwoFactorSetupResponse | null>(null);
  const [showManualKey, setShowManualKey] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { isSubmitting },
  } = useForm<TotpCodeFormData>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: {
      code: '',
    },
  });

  // useWatch is the React Compiler-friendly equivalent of watch() -- it lets
  // the surrounding component be memoized (watch() returns a fresh function on
  // every render, which the compiler can't optimize).
  const codeValue = useWatch({ control, name: 'code', defaultValue: '' });
  const codeRef = register('code');

  const {
    register: registerPassword,
    handleSubmit: handlePasswordSubmit,
    formState: { errors: passwordErrors, isSubmitting: isPasswordSubmitting },
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '' },
  });

  const onPasswordSubmit = async (data: PasswordFormData) => {
    try {
      const setup = await authApi.setup2FA(data.currentPassword);
      setSetupData(setup);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Current password is incorrect'));
    }
  };

  const onSubmit = async (formData: TotpCodeFormData) => {
    try {
      await authApi.confirmSetup2FA(formData.code);
      toast.success('Two-factor authentication enabled!');
      // Generate backup codes after successful 2FA setup
      try {
        const response = await authApi.generateBackupCodes(formData.code);
        setBackupCodes(response.codes);
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to generate backup codes'));
        onComplete();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Invalid verification code'));
      setValue('code', '');
    }
  };

  if (backupCodes) {
    return <BackupCodesDisplay codes={backupCodes} onDone={onComplete} />;
  }

  if (!setupData) {
    return (
      <form onSubmit={handlePasswordSubmit(onPasswordSubmit)} className="space-y-4">
        <div className="text-center">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Confirm your password
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Re-enter your current password to start two-factor authentication setup.
          </p>
        </div>

        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          error={passwordErrors.currentPassword?.message}
          {...registerPassword('currentPassword')}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isPasswordSubmitting}
          className="w-full"
        >
          Continue
        </Button>

        {onSkip && !isForced && (
          <button
            type="button"
            onClick={onSkip}
            className="w-full text-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
          >
            Skip for now
          </button>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Set Up Two-Factor Authentication
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Scan the QR code with your authenticator app (e.g., Google Authenticator, Authy).
        </p>
      </div>

      <div className="flex justify-center">
        <div className="bg-white p-4 rounded-lg">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL not optimizable by next/image */}
          <img
            src={setupData.qrCodeDataUrl}
            alt="2FA QR Code"
            className="w-48 h-48"
          />
        </div>
      </div>

      <div className="text-center">
        <button
          type="button"
          onClick={() => setShowManualKey(!showManualKey)}
          className="text-sm font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {showManualKey ? 'Hide manual key' : "Can't scan? Enter key manually"}
        </button>
        {showManualKey && (
          <div className="mt-2 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Manual entry key:</p>
            <p className="font-mono text-sm text-gray-900 dark:text-gray-100 select-all break-all">
              {setupData.secret}
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Enter the 6-digit code from your app"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          {...codeRef}
          onChange={(e) => {
            const filtered = e.target.value.replace(/\D/g, '');
            e.target.value = filtered;
            codeRef.onChange(e);
          }}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isSubmitting}
          disabled={codeValue.length !== 6}
          className="w-full"
        >
          Verify and Enable
        </Button>

        {onSkip && !isForced && (
          <button
            type="button"
            onClick={onSkip}
            className="w-full text-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
          >
            Skip for now
          </button>
        )}
      </form>
    </div>
  );
}
