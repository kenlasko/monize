'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import Image from 'next/image';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authApi } from '@/lib/auth';
import { buildEmailSchema } from '@/lib/zod-helpers';

type Status = 'verifying' | 'success' | 'error';

const buildResendSchema = (tc: (key: string) => string) =>
  z.object({
    email: buildEmailSchema(tc),
  });

type ResendFormData = z.infer<ReturnType<typeof buildResendSchema>>;

function VerifyEmailContent() {
  const t = useTranslations('auth.verifyEmail');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // A missing token can never verify, so start straight in the error/resend
  // state; a present token starts in "verifying" while the request runs.
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'error');
  const [resendSubmitted, setResendSubmitted] = useState(false);
  const [isResending, setIsResending] = useState(false);
  // Guards against React's double-invoked effect (dev/strict mode) consuming
  // the single-use token twice, which would flip a success into an error.
  const verifyStarted = useRef(false);

  useEffect(() => {
    if (!token || verifyStarted.current) return;
    verifyStarted.current = true;
    (async () => {
      try {
        await authApi.verifyEmail(token);
        setStatus('success');
      } catch {
        setStatus('error');
      }
    })();
  }, [token]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResendFormData>({
    resolver: zodResolver(buildResendSchema(tc)),
  });

  const onResend = async (data: ResendFormData) => {
    setIsResending(true);
    try {
      await authApi.resendVerification(data.email);
    } catch {
      // Show the generic confirmation regardless to avoid leaking whether an
      // account exists (matches the forgot-password flow).
    } finally {
      setIsResending(false);
      setResendSubmitted(true);
    }
  };

  if (status === 'verifying') {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400">
        {t('verifying')}
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="text-center space-y-4">
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
          <p className="text-sm text-green-800 dark:text-green-200">
            {t('successMessage')}
          </p>
        </div>
        <Link
          href="/login"
          className="inline-block font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {ta('backToSignIn')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 text-center">
        <p className="text-sm text-red-800 dark:text-red-200">{t('errorMessage')}</p>
      </div>

      {resendSubmitted ? (
        <div className="text-center space-y-4">
          <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <p className="text-sm text-green-800 dark:text-green-200">
              {t('resendSuccess')}
            </p>
          </div>
          <Link
            href="/login"
            className="inline-block font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {ta('backToSignIn')}
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onResend)} className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 text-center">
            {t('resendDescription')}
          </p>
          <Input
            label={t('emailLabel')}
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            isLoading={isResending}
            className="w-full"
          >
            {t('resendButton')}
          </Button>
          <p className="text-center text-sm">
            <Link
              href="/login"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {ta('backToSignIn')}
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  const t = useTranslations('auth.verifyEmail');
  const tc = useTranslations('common');
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
          <h2 className="mt-4 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            {t('title')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            {t('subtitle')}
          </p>
        </div>
        <Suspense fallback={<div className="text-center text-gray-500 dark:text-gray-400">{tc('loading')}</div>}>
          <VerifyEmailContent />
        </Suspense>
      </div>
    </div>
  );
}
