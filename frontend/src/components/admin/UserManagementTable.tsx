'use client';

import { useMemo } from 'react';
import { AdminUser } from '@/types/auth';
import { Button } from '@/components/ui/Button';
import { useDateFormat } from '@/hooks/useDateFormat';

interface UserManagementTableProps {
  users: AdminUser[];
  currentUserId: string;
  onChangeRole: (user: AdminUser, role: 'admin' | 'user') => void;
  onToggleStatus: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onDeleteUser: (user: AdminUser) => void;
}

export function UserManagementTable({
  users,
  currentUserId,
  onChangeRole,
  onToggleStatus,
  onResetPassword,
  onDeleteUser,
}: UserManagementTableProps) {
  const { formatDate } = useDateFormat();

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [users]);

  const getUserDisplayName = (user: AdminUser): string => {
    if (user.firstName || user.lastName) {
      return [user.firstName, user.lastName].filter(Boolean).join(' ');
    }
    return user.email || 'Unknown';
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              User
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Provider
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Last Login
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {sortedUsers.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <tr key={user.id} className={isSelf ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}>
                {/* User info */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {getUserDisplayName(user)}
                    {isSelf && (
                      <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">(you)</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {user.email || 'No email'}
                  </div>
                </td>

                {/* Role */}
                <td className="px-6 py-4 whitespace-nowrap">
                  {isSelf ? (
                    <RoleBadge role={user.role} />
                  ) : (
                    <select
                      value={user.role}
                      onChange={(e) => onChangeRole(user, e.target.value as 'admin' | 'user')}
                      className="text-sm rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="admin">Admin</option>
                      <option value="user">User</option>
                    </select>
                  )}
                </td>

                {/* Provider */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    user.authProvider === 'oidc'
                      ? 'bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
                  }`}>
                    {user.authProvider === 'oidc' ? 'SSO' : 'Local'}
                  </span>
                </td>

                {/* Status */}
                <td className="px-6 py-4 whitespace-nowrap">
                  {isSelf ? (
                    <StatusBadge isActive={user.isActive} />
                  ) : (
                    <button
                      onClick={() => onToggleStatus(user)}
                      className="group flex items-center"
                      title={user.isActive ? 'Click to disable' : 'Click to enable'}
                    >
                      <StatusBadge isActive={user.isActive} clickable />
                    </button>
                  )}
                </td>

                {/* Last Login */}
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {user.lastLogin
                    ? `${formatDate(new Date(user.lastLogin))} ${new Date(user.lastLogin).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                    : 'Never'}
                </td>

                {/* Actions */}
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-2">
                  {!isSelf && (
                    <>
                      {user.hasPassword && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onResetPassword(user)}
                        >
                          Reset Password
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDeleteUser(user)}
                        className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {sortedUsers.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No users found.
        </div>
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      role === 'admin'
        ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
    }`}>
      {role === 'admin' ? 'Admin' : 'User'}
    </span>
  );
}

function StatusBadge({ isActive, clickable }: { isActive: boolean; clickable?: boolean }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      isActive
        ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200'
        : 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200'
    } ${clickable ? 'cursor-pointer hover:opacity-80' : ''}`}>
      {isActive ? 'Active' : 'Disabled'}
    </span>
  );
}
