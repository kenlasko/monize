'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authApi } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { User } from '@/types/auth';

const verifySchema = z.object({
  code: z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
  rememberDevice: z.boolean(),
});

type VerifyFormData = z.infer<typeof verifySchema>;

interface TwoFactorVerifyProps {
  tempToken: string;
  onVerified: (user: User) => void;
  onCancel: () => void;
}

export function TwoFactorVerify({ tempToken, onVerified, onCancel }: TwoFactorVerifyProps) {
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
  } = useForm<VerifyFormData>({
    resolver: zodResolver(verifySchema),
    defaultValues: {
      code: '',
      rememberDevice: false,
    },
  });

  const codeValue = watch('code');
  const codeRef = register('code');

  const onSubmit = async (formData: VerifyFormData) => {
    if (formData.code.length !== 6) return;

    setIsLoading(true);
    try {
      const response = await authApi.verify2FA(tempToken, formData.code, formData.rememberDevice);
      if (response.user) {
        onVerified(response.user);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Invalid verification code'));
      setValue('code', '');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Two-Factor Authentication
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Verification Code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          autoFocus
          {...codeRef}
          onChange={(e) => {
            const filtered = e.target.value.replace(/\D/g, '');
            e.target.value = filtered;
            codeRef.onChange(e);
          }}
        />

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            {...register('rememberDevice')}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Don&apos;t ask again on this browser for 30 days
          </span>
        </label>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isLoading}
          disabled={codeValue.length !== 6}
          className="w-full"
        >
          Verify
        </Button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full text-center text-sm font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Back to login
        </button>
      </form>
    </div>
  );
}
