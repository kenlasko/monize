'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userSettingsApi } from '@/lib/user-settings';
import { useAuthStore } from '@/store/authStore';
import { User, UpdateProfileData } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';

interface ProfileSectionProps {
  user: User;
  onUserUpdated: (user: User) => void;
}

export function ProfileSection({ user, onUserUpdated }: ProfileSectionProps) {
  const { setUser } = useAuthStore();
  const [firstName, setFirstName] = useState(user.firstName || '');
  const [lastName, setLastName] = useState(user.lastName || '');
  const [email, setEmail] = useState(user.email);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingProfile(true);
    try {
      const data: UpdateProfileData = {};
      if (firstName !== (user.firstName || '')) data.firstName = firstName;
      if (lastName !== (user.lastName || '')) data.lastName = lastName;
      if (email !== user.email) data.email = email;

      if (Object.keys(data).length === 0) {
        toast.error('No changes to save');
        return;
      }

      const updatedUser = await userSettingsApi.updateProfile(data);
      onUserUpdated(updatedUser);
      setUser(updatedUser);
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
      <form onSubmit={handleUpdateProfile}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="First Name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="Enter your first name"
          />
          <Input
            label="Last Name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Enter your last name"
          />
        </div>
        <div className="mt-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={isUpdatingProfile}>
            {isUpdatingProfile ? 'Saving...' : 'Save Profile'}
          </Button>
        </div>
      </form>
    </div>
  );
}
