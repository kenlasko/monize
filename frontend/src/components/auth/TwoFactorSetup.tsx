'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authApi } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { TwoFactorSetupResponse } from '@/types/auth';

const totpCodeSchema = z.object({
  code: z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

type TotpCodeFormData = z.infer<typeof totpCodeSchema>;

interface TwoFactorSetupProps {
  onComplete: () => void;
  onSkip?: () => void;
  isForced?: boolean;
}

export function TwoFactorSetup({ onComplete, onSkip, isForced }: TwoFactorSetupProps) {
  const [setupData, setSetupData] = useState<TwoFactorSetupResponse | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(true);
  const [showManualKey, setShowManualKey] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { isSubmitting },
  } = useForm<TotpCodeFormData>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: {
      code: '',
    },
  });

  const codeValue = watch('code');
  const codeRef = register('code');

  useEffect(() => {
    const initSetup = async () => {
      try {
        const data = await authApi.setup2FA();
        setSetupData(data);
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to initialize 2FA setup'));
      } finally {
        setIsSettingUp(false);
      }
    };
    initSetup();
  }, []);

  const onSubmit = async (formData: TotpCodeFormData) => {
    try {
      await authApi.confirmSetup2FA(formData.code);
      toast.success('Two-factor authentication enabled!');
      onComplete();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Invalid verification code'));
      setValue('code', '');
    }
  };

  if (isSettingUp) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!setupData) {
    return (
      <div className="text-center py-4">
        <p className="text-red-600 dark:text-red-400">Failed to load 2FA setup. Please try again.</p>
      </div>
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
