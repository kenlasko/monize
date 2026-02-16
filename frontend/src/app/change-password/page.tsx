'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import Image from 'next/image';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])/;

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(100, 'Password must be less than 100 characters')
      .regex(
        passwordRegex,
        'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
      ),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

type ChangePasswordFormData = z.infer<typeof changePasswordSchema>;

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ChangePasswordFormData>({
    resolver: zodResolver(changePasswordSchema),
  });

  const onSubmit = async (data: ChangePasswordFormData) => {
    setIsLoading(true);
    try {
      await userSettingsApi.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });

      // Refresh user profile to get updated mustChangePassword: false
      const updatedUser = await authApi.getProfile();
      setUser(updatedUser);

      toast.success('Password changed successfully');
      router.push('/dashboard');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to change password'));
    } finally {
      setIsLoading(false);
    }
  };

  // If the user doesn't need to change password, redirect to dashboard
  useEffect(() => {
    if (user && !user.mustChangePassword) {
      router.push('/dashboard');
    }
  }, [user, router]);

  if (user && !user.mustChangePassword) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
          <h2 className="mt-4 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            Change Your Password
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Your password must be changed before you can continue.
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <Input
              label="Current Password"
              type="password"
              autoComplete="current-password"
              error={errors.currentPassword?.message}
              {...register('currentPassword')}
            />

            <Input
              label="New Password"
              type="password"
              autoComplete="new-password"
              error={errors.newPassword?.message}
              {...register('newPassword')}
            />

            <Input
              label="Confirm New Password"
              type="password"
              autoComplete="new-password"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Password must be at least 8 characters and contain an uppercase letter, a lowercase
            letter, a number, and a special character.
          </p>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            isLoading={isLoading}
            className="w-full"
          >
            Change Password
          </Button>
        </form>
      </div>
    </div>
  );
}
