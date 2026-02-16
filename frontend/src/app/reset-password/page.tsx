'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import Image from 'next/image';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authApi } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';

const schema = z
  .object({
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/(?=.*[a-z])/, 'Must contain a lowercase letter')
      .regex(/(?=.*[A-Z])/, 'Must contain an uppercase letter')
      .regex(/(?=.*\d)/, 'Must contain a number')
      .regex(/(?=.*[^A-Za-z\d\s])/, 'Must contain a special character'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormData = z.infer<typeof schema>;

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  if (!token) {
    return (
      <div className="text-center space-y-4">
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-sm text-red-800 dark:text-red-200">
            Invalid or missing reset token.
          </p>
        </div>
        <Link
          href="/forgot-password"
          className="inline-block font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Request a new reset link
        </Link>
      </div>
    );
  }

  const onSubmit = async (data: FormData) => {
    setIsLoading(true);
    try {
      await authApi.resetPassword(token, data.newPassword);
      toast.success('Password reset successfully!');
      router.push('/login');
    } catch (error) {
      toast.error(
        getErrorMessage(error, 'Failed to reset password. The link may have expired.'),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6">
      <Input
        label="New Password"
        type="password"
        autoComplete="new-password"
        error={errors.newPassword?.message}
        {...register('newPassword')}
      />
      <Input
        label="Confirm Password"
        type="password"
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...register('confirmPassword')}
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        isLoading={isLoading}
        className="w-full"
      >
        Reset password
      </Button>
      <p className="text-center text-sm">
        <Link
          href="/login"
          className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
          <h2 className="mt-4 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            Set new password
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Enter your new password below.
          </p>
        </div>
        <Suspense fallback={<div className="text-center text-gray-500 dark:text-gray-400">Loading...</div>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
