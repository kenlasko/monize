'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userSettingsApi, DeleteDataOptions } from '@/lib/user-settings';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/lib/errors';
import { User } from '@/types/auth';
import { takeOidcReauthArtifact } from '@/lib/stepUpToken';

interface DowngradeNoticeProps {
  isDelegate: boolean;
}

function DelegateDeleteNotice({ isDelegate }: DowngradeNoticeProps) {
  const t = useTranslations('settings.dangerZone');
  if (!isDelegate) return null;
  return (
    <div className="mb-4 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-3 text-sm text-amber-900 dark:text-amber-100">
      <p className="font-semibold">{t('deleteAccount.delegateNotice.title')}</p>
      <p className="mt-1">
        {t('deleteAccount.delegateNotice.body')}
      </p>
    </div>
  );
}

interface DangerZoneSectionProps {
  user: User;
}

export function DangerZoneSection({ user }: DangerZoneSectionProps) {
  const t = useTranslations('settings.dangerZone');
  const router = useRouter();
  const { logout } = useAuthStore();
  // A delegate of another account sees a tailored warning explaining
  // that Delete Account demotes them to delegate-only rather than
  // truly removing their login. Default to [] so tests that don't
  // bother to seed the delegation slice of the auth store don't blow
  // up on .some() -- the production store always initialises this.
  const availableContexts = useAuthStore((s) => s.availableContexts);
  const isDelegate = (availableContexts ?? []).some((c) => !c.isSelf);

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
      toast.error(t('deleteAccount.errors.typeDelete'));
      return;
    }
    if (!isOidc && !deleteAccountPassword) {
      toast.error(t('deleteAccount.errors.passwordRequired'));
      return;
    }

    setIsDeleting(true);
    try {
      let authData: { oidcIdToken?: string; password?: string };
      if (isOidc) {
        // Real re-authentication, not a claim that one happened: without an
        // artifact in hand we hand the user to their identity provider and stop.
        const artifact = takeOidcReauthArtifact('delete-account', '/settings');
        if (!artifact) {
          toast.success(t('deleteAccount.toasts.reauthRedirect'));
          return;
        }
        authData = { oidcIdToken: artifact };
      } else {
        authData = { password: deleteAccountPassword };
      }
      const res = await userSettingsApi.deleteAccount(authData);
      if (res.downgraded) {
        toast.success(
          t('deleteAccount.toasts.downgraded'),
          { duration: 12000 },
        );
      } else {
        toast.success(t('deleteAccount.toasts.deleted'));
      }
      logout();
      router.push('/login');
    } catch (error) {
      toast.error(getErrorMessage(error, t('deleteAccount.toasts.failed')));
      setIsDeleting(false);
    }
  };

  const handleDeleteData = async () => {
    if (!isOidc && !password) {
      toast.error(t('deleteAccount.errors.passwordRequired'));
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
        const artifact = takeOidcReauthArtifact('delete-data', '/settings');
        if (!artifact) {
          toast.success(t('deleteAccount.toasts.reauthRedirect'));
          return;
        }
        options.oidcIdToken = artifact;
      } else {
        options.password = password;
      }

      const result = await userSettingsApi.deleteData(options);

      const totalDeleted = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
      toast.success(t('deleteData.toasts.success', { count: totalDeleted }));

      // Reset form
      setShowDataDelete(false);
      setPassword('');
      setDeleteAccounts(false);
      setDeleteCategories(false);
      setDeletePayees(false);
      setDeleteExchangeRates(false);
    } catch (error) {
      toast.error(getErrorMessage(error, t('deleteData.toasts.failed')));
    } finally {
      setIsDeletingData(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 border-2 border-red-200 dark:border-red-800">
      <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-6">{t('heading')}</h2>

      {/* Delete Data Section */}
      <div className="mb-6 pb-6 border-b border-red-100 dark:border-red-900">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{t('deleteData.heading')}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t('deleteData.description')}
        </p>

        {!showDataDelete ? (
          <Button
            variant="danger"
            onClick={() => setShowDataDelete(true)}
          >
            {t('deleteData.openButton')}
          </Button>
        ) : (
          <div className="space-y-4 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              {t('deleteData.alwaysDeletedHeading')}
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
              {t('deleteData.optionalHeading')}
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteAccounts}
                  onChange={(e) => setDeleteAccounts(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                {t('deleteData.accountsOption')}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteCategories}
                  onChange={(e) => setDeleteCategories(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                {t('deleteData.categoriesOption')}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deletePayees}
                  onChange={(e) => setDeletePayees(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                {t('deleteData.payeesOption')}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={deleteExchangeRates}
                  onChange={(e) => setDeleteExchangeRates(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                />
                {t('deleteData.currencyPreferencesOption')}
              </label>
            </div>

            {!deleteAccounts && (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                {t('deleteData.balanceResetNote')}
              </p>
            )}

            <div className="pt-2 border-t border-red-200 dark:border-red-800">
              <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">
                {isOidc
                  ? t('deleteData.oidcConfirmLabel')
                  : t('deleteData.passwordConfirmLabel')}
              </p>
              {isOidc ? (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={handleDeleteData}
                    disabled={isDeletingData}
                  >
                    {t('deleteData.oidcReauthButton')}
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
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('deleteData.passwordPlaceholder')}
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
                      {isDeletingData ? t('deleteData.deletingButton') : t('deleteData.confirmButton')}
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
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{t('deleteAccount.heading')}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t('deleteAccount.description')}
        </p>

        <DelegateDeleteNotice isDelegate={isDelegate} />

        {!showDeleteConfirm ? (
          <Button
            variant="danger"
            onClick={() => setShowDeleteConfirm(true)}
          >
            {t('deleteAccount.openButton')}
          </Button>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium">
              {t('deleteAccount.typeDeleteLabel')}
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={t('deleteAccount.typeDeletePlaceholder')}
            />
            {!isOidc && (
              <>
                <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                  {t('deleteAccount.enterPasswordLabel')}
                </p>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={deleteAccountPassword}
                  onChange={(e) => setDeleteAccountPassword(e.target.value)}
                  placeholder={t('deleteAccount.enterPasswordPlaceholder')}
                />
              </>
            )}
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={handleDeleteAccount}
                disabled={isDeleting || deleteConfirmText !== 'DELETE' || (!isOidc && !deleteAccountPassword)}
              >
                {isDeleting ? t('deleteAccount.deletingButton') : t('deleteAccount.confirmButton')}
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
