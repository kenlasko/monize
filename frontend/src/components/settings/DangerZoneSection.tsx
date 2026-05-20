'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userSettingsApi, DeleteDataOptions } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/lib/errors';
import { User } from '@/types/auth';

interface DowngradeNoticeProps {
  isDelegate: boolean;
}

function DelegateDeleteNotice({ isDelegate }: DowngradeNoticeProps) {
  if (!isDelegate) return null;
  return (
    <div className="mb-4 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-3 text-sm text-amber-900 dark:text-amber-100">
      <p className="font-semibold">You are a delegate of another account.</p>
      <p className="mt-1">
        Deleting your account will remove your own data, but your login
        and the shared access others granted you stay so the delegation
        keeps working. To revoke that access, ask the owner to remove
        you from their Shared Access list first.
      </p>
    </div>
  );
}

interface DangerZoneSectionProps {
  user: User;
}

export function DangerZoneSection({ user }: DangerZoneSectionProps) {
  const router = useRouter();
  const { logout } = useAuthStore();
  // A delegate of another account sees a tailored warning explaining
  // that Delete Account demotes them to delegate-only rather than
  // truly removing their login.
  const availableContexts = useAuthStore((s) => s.availableContexts);
  const isDelegate = availableContexts.some((c) => !c.isSelf);

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteAccountPassword, setDeleteAccountPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Delete data state
  const [showDataDelete, setShowDataDelete] = useState(false);
  const [isDeletingData, setIsDeletingData] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteAccounts, setDeleteAccounts] = useState(false);
  const [deleteCategories, setDeleteCategories] = useState(false);
  const [deletePayees, setDeletePayees] = useState(false);
  const [deleteExchangeRates, setDeleteExchangeRates] = useState(false);

  const isOidc = user.authProvider === 'oidc';

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      toast.error('Please type DELETE to confirm');
      return;
    }
    if (!isOidc && !deleteAccountPassword) {
      toast.error('Please enter your password to confirm');
      return;
    }

    setIsDeleting(true);
    try {
      const authData = isOidc
        ? { oidcIdToken: 'oidc-session-confirmed' }
        : { password: deleteAccountPassword };
      const res = await userSettingsApi.deleteAccount(authData);
      if (res.downgraded) {
        toast.success(
          'Your own data was removed. Your login and shared access are kept so the delegation stays in place.',
          { duration: 12000 },
        );
      } else {
        toast.success('Account deleted');
      }
      logout();
      router.push('/login');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete account'));
      setIsDeleting(false);
    }
  };

  const handleDeleteData = async () => {
    if (!isOidc && !password) {
      toast.error('Please enter your password to confirm');
      return;
    }

    setIsDeletingData(true);
    try {
      const options: DeleteDataOptions = {
        deleteAccounts,
        deleteCategories,
        deletePayees,
        deleteExchangeRates,
      };

      if (isOidc) {
        options.oidcIdToken = 'oidc-session-confirmed';
      } else {
        options.password = password;
      }

      const result = await userSettingsApi.deleteData(options);

      const totalDeleted = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
      toast.success(`Deleted ${totalDeleted} records successfully`);

      // Reset form
      setShowDataDelete(false);
      setPassword('');
      setDeleteAccounts(false);
      setDeleteCategories(false);
      setDeletePayees(false);
      setDeleteExchangeRates(false);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete data'));
    } finally {
      setIsDeletingData(false);
    }
  };

  const handleOidcReauthData = () => {
    sessionStorage.setItem('dataDeletePending', JSON.stringify({
      deleteAccounts,
      deleteCategories,
      deletePayees,
      deleteExchangeRates,
    }));
    authApi.initiateOidc();
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 border-2 border-red-200 dark:border-red-800">
      <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-6">Danger Zone</h2>

      {/* Delete Data Section */}
      <div className="mb-6 pb-6 border-b border-red-100 dark:border-red-900">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Delete Data</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Remove financial data from your account. This cannot be undone.
        </p>

        {!showDataDelete ? (
          <Button
            variant="danger"
            onClick={() => setShowDataDelete(true)}
          >
            Delete Data...
          </Button>
        ) : (
          <div className="space-y-4 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              The following will always be deleted:
            </p>
            <ul className="text-sm text-gray-700 dark:text-gray-300 list-disc ml-5 space-y-1">
              <li>All transactions and splits</li>
              <li>All scheduled/recurring transactions</li>
              <li>All securities, prices, holdings, and investment transactions</li>
              <li>All budgets and budget alerts</li>
              <li>Monthly account balance summaries</li>
              <li>Custom reports, tags, and import mappings</li>
              <li>Action history (undo/redo)</li>
            </ul>

            <p className="text-sm font-medium text-red-700 dark:text-red-300 pt-2">
              Optionally also delete:
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteAccounts}
                  onChange={(e) => setDeleteAccounts(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                Accounts
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteCategories}
                  onChange={(e) => setDeleteCategories(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                Categories
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deletePayees}
                  onChange={(e) => setDeletePayees(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                Payees
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteExchangeRates}
                  onChange={(e) => setDeleteExchangeRates(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                Currency preferences
              </label>
            </div>

            {!deleteAccounts && (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                Account balances will be reset to their opening balance.
              </p>
            )}

            <div className="pt-2 border-t border-red-200 dark:border-red-800">
              <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">
                {isOidc
                  ? 'Re-authenticate with your identity provider to confirm:'
                  : 'Enter your password to confirm:'}
              </p>
              {isOidc ? (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={handleOidcReauthData}
                    disabled={isDeletingData}
                  >
                    Re-authenticate and Delete
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowDataDelete(false);
                      setDeleteAccounts(false);
                      setDeleteCategories(false);
                      setDeletePayees(false);
                      setDeleteExchangeRates(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && password) {
                        handleDeleteData();
                      }
                    }}
                  />
                  <div className="flex gap-2 mt-3">
                    <Button
                      variant="danger"
                      onClick={handleDeleteData}
                      disabled={isDeletingData || !password}
                    >
                      {isDeletingData ? 'Deleting...' : 'Confirm Delete Data'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowDataDelete(false);
                        setPassword('');
                        setDeleteAccounts(false);
                        setDeleteCategories(false);
                        setDeletePayees(false);
                        setDeleteExchangeRates(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Delete Account Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Delete Account</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Permanently delete your account and all associated data. This cannot be undone.
        </p>

        <DelegateDeleteNotice isDelegate={isDelegate} />

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
            {!isOidc && (
              <>
                <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                  Enter your password:
                </p>
                <Input
                  type="password"
                  value={deleteAccountPassword}
                  onChange={(e) => setDeleteAccountPassword(e.target.value)}
                  placeholder="Enter your password"
                />
              </>
            )}
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={handleDeleteAccount}
                disabled={isDeleting || deleteConfirmText !== 'DELETE' || (!isOidc && !deleteAccountPassword)}
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText('');
                  setDeleteAccountPassword('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
