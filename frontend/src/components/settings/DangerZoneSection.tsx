'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userSettingsApi } from '@/lib/user-settings';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/lib/errors';

export function DangerZoneSection() {
  const router = useRouter();
  const { logout } = useAuthStore();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      toast.error('Please type DELETE to confirm');
      return;
    }

    setIsDeleting(true);
    try {
      await userSettingsApi.deleteAccount();
      toast.success('Account deleted');
      logout();
      router.push('/login');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete account'));
      setIsDeleting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 border-2 border-red-200 dark:border-red-800">
      <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-4">Danger Zone</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Once you delete your account, there is no going back. Please be certain.
      </p>

      {!showDeleteConfirm ? (
        <Button
          variant="danger"
          onClick={() => setShowDeleteConfirm(true)}
        >
          Delete Account
        </Button>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-red-600 dark:text-red-400 font-medium">
            Type DELETE to confirm account deletion:
          </p>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder="Type DELETE"
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={handleDeleteAccount}
              disabled={isDeleting || deleteConfirmText !== 'DELETE'}
            >
              {isDeleting ? 'Deleting...' : 'Confirm Delete'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteConfirm(false);
                setDeleteConfirmText('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
