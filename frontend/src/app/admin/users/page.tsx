'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { UserManagementTable } from '@/components/admin/UserManagementTable';
import { ResetPasswordModal } from '@/components/admin/ResetPasswordModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuthStore } from '@/store/authStore';
import { adminApi } from '@/lib/admin';
import { AdminUser } from '@/types/auth';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('AdminUsers');

export default function AdminUsersPage() {
  const router = useRouter();
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Reset password modal state
  const [resetPasswordModal, setResetPasswordModal] = useState<{
    isOpen: boolean;
    temporaryPassword: string;
    userName: string;
  }>({ isOpen: false, temporaryPassword: '', userName: '' });

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    variant: 'danger' | 'warning' | 'info';
    confirmLabel: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    variant: 'danger',
    confirmLabel: 'Confirm',
    onConfirm: () => {},
  });

  // Redirect non-admins
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      router.push('/dashboard');
    }
  }, [currentUser, router]);

  const loadUsers = useCallback(async () => {
    try {
      const data = await adminApi.getUsers();
      setUsers(data);
    } catch (error) {
      logger.error('Failed to load users:', error);
      toast.error('Failed to load users');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleChangeRole = async (user: AdminUser, role: 'admin' | 'user') => {
    if (role === user.role) return;

    const action = role === 'admin' ? 'promote' : 'demote';
    const userName = user.firstName || user.email || 'this user';

    setConfirmDialog({
      isOpen: true,
      title: `${role === 'admin' ? 'Promote' : 'Demote'} User?`,
      message: `Are you sure you want to ${action} ${userName} to ${role}?`,
      variant: role === 'admin' ? 'info' : 'warning',
      confirmLabel: role === 'admin' ? 'Promote to Admin' : 'Demote to User',
      onConfirm: async () => {
        try {
          const updated = await adminApi.updateUserRole(user.id, role);
          setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
          toast.success(`${userName} is now ${role === 'admin' ? 'an admin' : 'a user'}`);
        } catch (error) {
          toast.error(getErrorMessage(error, `Failed to ${action} user`));
          // Reload to reset the select back to the actual value
          loadUsers();
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const handleToggleStatus = async (user: AdminUser) => {
    const newStatus = !user.isActive;
    const userName = user.firstName || user.email || 'this user';
    const action = newStatus ? 'enable' : 'disable';

    if (!newStatus) {
      // Confirm before disabling
      setConfirmDialog({
        isOpen: true,
        title: 'Disable User?',
        message: `Are you sure you want to disable ${userName}? They will be unable to log in.`,
        variant: 'warning',
        confirmLabel: 'Disable User',
        onConfirm: async () => {
          try {
            const updated = await adminApi.updateUserStatus(user.id, false);
            setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
            toast.success(`${userName} has been disabled`);
          } catch (error) {
            toast.error(getErrorMessage(error, 'Failed to disable user'));
          }
          setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        },
      });
    } else {
      // Enable without confirmation
      try {
        const updated = await adminApi.updateUserStatus(user.id, true);
        setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
        toast.success(`${userName} has been enabled`);
      } catch (error) {
        toast.error(getErrorMessage(error, `Failed to ${action} user`));
      }
    }
  };

  const handleResetPassword = (user: AdminUser) => {
    const userName = user.firstName || user.email || 'this user';

    setConfirmDialog({
      isOpen: true,
      title: 'Reset Password?',
      message: `This will generate a new temporary password for ${userName}. They will be required to change it on next login.`,
      variant: 'warning',
      confirmLabel: 'Reset Password',
      onConfirm: async () => {
        try {
          const result = await adminApi.resetUserPassword(user.id);
          setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
          setResetPasswordModal({
            isOpen: true,
            temporaryPassword: result.temporaryPassword,
            userName: userName,
          });
        } catch (error) {
          toast.error(getErrorMessage(error, 'Failed to reset password'));
          setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  const handleDeleteUser = (user: AdminUser) => {
    const userName = user.firstName || user.email || 'this user';

    setConfirmDialog({
      isOpen: true,
      title: 'Delete User?',
      message: `Are you sure you want to delete ${userName}? This will permanently remove their account and all associated data. This action cannot be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete User',
      onConfirm: async () => {
        try {
          await adminApi.deleteUser(user.id);
          setUsers((prev) => prev.filter((u) => u.id !== user.id));
          toast.success(`${userName} has been deleted`);
        } catch (error) {
          toast.error(getErrorMessage(error, 'Failed to delete user'));
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  if (currentUser?.role !== 'admin') {
    return null;
  }

  return (
    <ProtectedRoute>
      <PageLayout>
        <PageHeader
          title="User Management"
          subtitle={`${users.length} user${users.length !== 1 ? 's' : ''}`}
        />

        <div className="bg-white dark:bg-gray-900 shadow rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : (
            <UserManagementTable
              users={users}
              currentUserId={currentUser.id}
              onChangeRole={handleChangeRole}
              onToggleStatus={handleToggleStatus}
              onResetPassword={handleResetPassword}
              onDeleteUser={handleDeleteUser}
            />
          )}
        </div>

        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        />

        <ResetPasswordModal
          isOpen={resetPasswordModal.isOpen}
          temporaryPassword={resetPasswordModal.temporaryPassword}
          userName={resetPasswordModal.userName}
          onClose={() => setResetPasswordModal((prev) => ({ ...prev, isOpen: false }))}
        />
      </PageLayout>
    </ProtectedRoute>
  );
}
