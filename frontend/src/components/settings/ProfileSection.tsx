'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userSettingsApi } from '@/lib/user-settings';
import { useAuthStore } from '@/store/authStore';
import { User, UpdateProfileData } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';

const profileSchema = z.object({
  firstName: z
    .string()
    .max(100, 'First name must be 100 characters or less')
    .optional()
    .or(z.literal('')),
  lastName: z
    .string()
    .max(100, 'Last name must be 100 characters or less')
    .optional()
    .or(z.literal('')),
  email: z
    .string()
    .min(1, 'Email is required')
    .email('Please enter a valid email address')
    .max(254, 'Email must be 254 characters or less'),
  currentPassword: z
    .string()
    .max(128, 'Password must be 128 characters or less')
    .optional()
    .or(z.literal('')),
});

type ProfileFormData = z.infer<typeof profileSchema>;

interface ProfileSectionProps {
  user: User;
  onUserUpdated: (user: User) => void;
}

export function ProfileSection({ user, onUserUpdated }: ProfileSectionProps) {
  const { setUser } = useAuthStore();
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email,
      currentPassword: '',
    },
  });

  const watchedEmail = watch('email');
  const isEmailChanged = watchedEmail !== user.email;

  const onSubmit = async (formData: ProfileFormData) => {
    setIsUpdatingProfile(true);
    try {
      const data: UpdateProfileData = {};
      if (formData.firstName !== (user.firstName || '')) data.firstName = formData.firstName;
      if (formData.lastName !== (user.lastName || '')) data.lastName = formData.lastName;
      if (isEmailChanged) {
        if (!formData.currentPassword) {
          toast.error('Current password is required to change email');
          return;
        }
        data.email = formData.email;
        data.currentPassword = formData.currentPassword;
      }

      if (Object.keys(data).length === 0) {
        toast.error('No changes to save');
        return;
      }

      const updatedUser = await userSettingsApi.updateProfile(data);
      onUserUpdated(updatedUser);
      setUser(updatedUser);
      setValue('currentPassword', '');
      toast.success('Profile updated successfully');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update profile'));
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Profile</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="First Name"
            {...register('firstName')}
            error={errors.firstName?.message}
            placeholder="Enter your first name"
          />
          <Input
            label="Last Name"
            {...register('lastName')}
            error={errors.lastName?.message}
            placeholder="Enter your last name"
          />
        </div>
        <div className="mt-4">
          <Input
            label="Email"
            type="email"
            {...register('email')}
            error={errors.email?.message}
            placeholder="Enter your email"
          />
        </div>
        {isEmailChanged && (
          <div className="mt-4">
            <Input
              label="Current Password"
              type="password"
              {...register('currentPassword')}
              error={errors.currentPassword?.message}
              placeholder="Required to change email"
            />
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Password confirmation is required when changing your email address.
            </p>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={isUpdatingProfile}>
            {isUpdatingProfile ? 'Saving...' : 'Save Profile'}
          </Button>
        </div>
      </form>
    </div>
  );
}
