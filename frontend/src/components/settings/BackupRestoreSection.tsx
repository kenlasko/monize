'use client';

import { useEffect, useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { isAxiosError } from 'axios';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  backupApi,
  BackupEncryptionStatus,
  BACKUP_PASSWORD_REQUIRED_CODE,
  isEncryptedBackupFile,
  RestoreResult,
} from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
import { getDateStringInTimezone, resolveTimezone } from '@/lib/utils';
import { usePreferencesStore } from '@/store/preferencesStore';
import { User } from '@/types/auth';

const RESTORE_LABELS: Record<string, string> = {
  userPreferences: 'User Preferences',
  userCurrencyPreferences: 'Currency Preferences',
  categories: 'Categories',
  payees: 'Payees',
  payeeAliases: 'Payee Aliases',
  accounts: 'Accounts',
  tags: 'Tags',
  scheduledTransactions: 'Scheduled Transactions',
  scheduledTransactionSplits: 'Scheduled Transaction Splits',
  scheduledTransactionOverrides: 'Scheduled Transaction Overrides',
  scheduledTransactionSplitTags: 'Scheduled Transaction Split Tags',
  securities: 'Securities',
  securityPrices: 'Security Prices',
  securityTags: 'Security Tags',
  holdings: 'Holdings',
  transactions: 'Transactions',
  transactionSplits: 'Transaction Splits',
  transactionTags: 'Transaction Tags',
  transactionSplitTags: 'Transaction Split Tags',
  investmentTransactions: 'Investment Transactions',
  loanRateChanges: 'Loan Rate Changes',
  loanScenarios: 'Loan Scenarios',
  budgets: 'Budgets',
  budgetCategories: 'Budget Categories',
  budgetPeriods: 'Budget Periods',
  budgetPeriodCategories: 'Budget Period Categories',
  budgetAlerts: 'Budget Alerts',
  customReports: 'Custom Reports',
  importColumnMappings: 'Import Column Mappings',
  monthlyAccountBalances: 'Monthly Account Balances',
  autoBackupSettings: 'Auto-Backup Settings',
  aiProviderConfigs: 'AI Provider Configurations',
  monteCarloScenarios: 'Monte Carlo Scenarios',
  monteCarloCashFlows: 'Monte Carlo Cash Flows',
};

function isBackupPasswordRequired(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const data = error.response?.data as { code?: string } | undefined;
  return data?.code === BACKUP_PASSWORD_REQUIRED_CODE;
}

interface BackupRestoreSectionProps {
  user: User;
}

export function BackupRestoreSection({ user }: BackupRestoreSectionProps) {
  const t = useTranslations('settings.backupRestore');
  const isOidc = user.authProvider === 'oidc';
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);

  const [encryption, setEncryption] = useState<BackupEncryptionStatus | null>(
    null,
  );
  const [encryptionLoading, setEncryptionLoading] = useState(true);

  const [isExporting, setIsExporting] = useState(false);
  const [exportPasswordPrompt, setExportPasswordPrompt] = useState(false);
  const [exportPassword, setExportPassword] = useState('');

  const [showRestore, setShowRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreFileEncrypted, setRestoreFileEncrypted] = useState(false);
  const [restoreBackupPassword, setRestoreBackupPassword] = useState('');
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Encryption setup state
  const [showEncryptionSetup, setShowEncryptionSetup] = useState(false);
  const [setupPassword, setSetupPassword] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    backupApi
      .getEncryptionStatus()
      .then((status) => {
        if (!cancelled) setEncryption(status);
      })
      .catch(() => {
        if (!cancelled) setEncryption({ enabled: false, needsBackupPassword: isOidc });
      })
      .finally(() => {
        if (!cancelled) setEncryptionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOidc]);

  const runExport = async (encryptionPassword?: string) => {
    setIsExporting(true);
    try {
      const blob = await backupApi.exportBackup(encryptionPassword);
      const url = URL.createObjectURL(blob);
      // Date the filename by the user's configured timezone preference, not UTC
      // or the browser's timezone. `toISOString()` renders in UTC (an evening
      // export in a negative-offset zone would be stamped with tomorrow), and
      // the browser's own timezone can differ from the preference the user set
      // in Settings (e.g. an Australia/Sydney preference viewed from US/Eastern).
      const today = getDateStringInTimezone(resolveTimezone(timezonePref));
      const filename = encryptionPassword
        ? `monize-backup-${today}.mzbe`
        : `monize-backup-${today}.json.gz`;

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(t('export.toasts.success'));
      setExportPasswordPrompt(false);
      setExportPassword('');
    } catch (error) {
      toast.error(getErrorMessage(error, t('export.toasts.failed')));
    } finally {
      setIsExporting(false);
    }
  };

  const handleExport = async () => {
    if (encryption?.enabled) {
      // Open the modal to capture the encryption password. Cleaner than
      // pre-populating any field: forces explicit confirmation that the
      // password the user is about to type matches their stored one.
      setExportPasswordPrompt(true);
      return;
    }
    await runExport();
  };

  const closeRestoreForm = () => {
    setShowRestore(false);
    setRestorePassword('');
    setRestoreFile(null);
    setRestoreFileEncrypted(false);
    setRestoreBackupPassword('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setRestoreFile(file);
    setRestoreBackupPassword('');
    // Sniff the file so the encrypted-backup password field only appears when
    // the upload is actually an encrypted Monize envelope.
    setRestoreFileEncrypted(file ? await isEncryptedBackupFile(file) : false);
  };

  const runRestore = async () => {
    if (!restoreFile) {
      toast.error(t('restore.toasts.pleaseSelectFile'));
      return;
    }
    if (!isOidc && !restorePassword) {
      toast.error(t('restore.toasts.pleaseEnterPassword'));
      return;
    }

    setIsRestoring(true);
    try {
      const authData = isOidc
        ? { oidcIdToken: 'oidc-session-confirmed' }
        : { password: restorePassword };

      const result = await backupApi.restoreBackup({
        file: restoreFile,
        ...authData,
        // Only relevant for encrypted backups; the account password above is a
        // separate identity check and is not the decryption key.
        backupPassword:
          restoreFileEncrypted && restoreBackupPassword
            ? restoreBackupPassword
            : undefined,
      });

      setRestoreResult(result);
      closeRestoreForm();
    } catch (error) {
      if (isBackupPasswordRequired(error)) {
        toast.error(t('restore.toasts.encryptedNeedsPassword'));
      } else {
        toast.error(getErrorMessage(error, t('restore.toasts.failed')));
      }
    } finally {
      setIsRestoring(false);
    }
  };

  const handleEnableEncryption = async () => {
    setSetupSaving(true);
    try {
      if (isOidc) {
        await backupApi.setBackupPassword(setupPassword);
      } else {
        await backupApi.enableLocalEncryption(setupPassword);
      }
      const status = await backupApi.getEncryptionStatus();
      setEncryption(status);
      setShowEncryptionSetup(false);
      setSetupPassword('');
      toast.success(t('encryption.toasts.enabled'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('encryption.toasts.enableFailed')));
    } finally {
      setSetupSaving(false);
    }
  };

  const handleDisableEncryption = async () => {
    try {
      await backupApi.disableEncryption();
      const status = await backupApi.getEncryptionStatus();
      setEncryption(status);
      toast.success(t('encryption.toasts.disabled'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('encryption.toasts.disableFailed')));
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
        {t('heading')}
      </h2>

      {/* Encryption Section */}
      <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          {t('encryption.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {isOidc
            ? t('encryption.descriptionOidc')
            : t('encryption.descriptionLocal')}
        </p>

        {encryptionLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('encryption.loading')}</p>
        ) : encryption?.enabled ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
              {t('encryption.enabledBadge')}
            </span>
            {isOidc && (
              <Button
                variant="outline"
                onClick={() => setShowEncryptionSetup(true)}
              >
                {t('encryption.changePasswordButton')}
              </Button>
            )}
            <Button variant="outline" onClick={handleDisableEncryption}>
              {t('encryption.disableButton')}
            </Button>
          </div>
        ) : (
          <Button onClick={() => setShowEncryptionSetup(true)}>
            {isOidc ? t('encryption.setPasswordButton') : t('encryption.enableEncryptedButton')}
          </Button>
        )}
      </div>

      {/* Export Section */}
      <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          {t('export.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t('export.description')}
        </p>
        <Button
          onClick={handleExport}
          disabled={isExporting}
        >
          {isExporting ? t('export.creatingButton') : t('export.downloadButton')}
        </Button>
      </div>

      {/* Restore Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          {t('restore.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t('restore.description')}
        </p>

        {!showRestore ? (
          <Button
            variant="outline"
            onClick={() => setShowRestore(true)}
          >
            {t('restore.openButton')}
          </Button>
        ) : (
          <div className="space-y-4 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                {t('restore.warning')}
              </p>
            </div>

            <div>
              <label htmlFor="backup-file-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('restore.selectFileLabel')}
              </label>
              <input
                id="backup-file-input"
                ref={fileInputRef}
                type="file"
                accept=".json,.json.gz,.gz,.mzbe"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-500 dark:text-gray-400
                  file:mr-4 file:py-2 file:px-4 file:rounded file:border-0
                  file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700
                  dark:file:bg-blue-900/30 dark:file:text-blue-300
                  hover:file:bg-blue-100 dark:hover:file:bg-blue-900/50
                  file:cursor-pointer cursor-pointer"
              />
            </div>

            {restoreFileEncrypted && (
              <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
                <label
                  htmlFor="backup-password-input"
                  className="block text-sm font-medium text-amber-700 dark:text-amber-300 mb-2"
                >
                  {t('restore.encryptedBackupLabel')}
                </label>
                <Input
                  id="backup-password-input"
                  type="password"
                  value={restoreBackupPassword}
                  onChange={(e) => setRestoreBackupPassword(e.target.value)}
                  placeholder={t('restore.backupPasswordPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runRestore();
                  }}
                />
              </div>
            )}

            <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300 mb-2">
                {isOidc
                  ? t('restore.oidcConfirmLabel')
                  : t('restore.passwordConfirmLabel')}
              </p>
              {isOidc ? (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={() => runRestore()}
                    disabled={isRestoring || !restoreFile}
                  >
                    {isRestoring ? t('restore.restoringButton') : t('restore.oidcRestoreButton')}
                  </Button>
                  <Button variant="outline" onClick={closeRestoreForm}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder={t('restore.passwordPlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && restorePassword && restoreFile) {
                        runRestore();
                      }
                    }}
                  />
                  <div className="flex gap-2 mt-3">
                    <Button
                      variant="danger"
                      onClick={() => runRestore()}
                      disabled={isRestoring || !restorePassword || !restoreFile}
                    >
                      {isRestoring ? t('restore.restoringButton') : t('restore.confirmRestoreButton')}
                    </Button>
                    <Button variant="outline" onClick={closeRestoreForm}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Encryption setup modal */}
      <Modal
        isOpen={showEncryptionSetup}
        onClose={() => {
          setShowEncryptionSetup(false);
          setSetupPassword('');
        }}
        maxWidth="sm"
      >
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {isOidc ? t('encryption.setupModal.titleOidc') : t('encryption.setupModal.titleLocal')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {isOidc
              ? t('encryption.setupModal.descriptionOidc')
              : t('encryption.setupModal.descriptionLocal')}
          </p>
          <Input
            type="password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            placeholder={isOidc ? t('encryption.setupModal.placeholderOidc') : t('encryption.setupModal.placeholderLocal')}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowEncryptionSetup(false);
                setSetupPassword('');
              }}
              disabled={setupSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEnableEncryption}
              disabled={setupSaving || !setupPassword}
            >
              {setupSaving ? t('encryption.setupModal.savingButton') : t('encryption.setupModal.confirmButton')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Export-time password prompt (when encryption is enabled) */}
      <Modal
        isOpen={exportPasswordPrompt}
        onClose={() => {
          setExportPasswordPrompt(false);
          setExportPassword('');
        }}
        maxWidth="sm"
      >
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {t('export.exportPasswordModal.title')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('export.exportPasswordModal.description')}
          </p>
          <Input
            type="password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
            placeholder={isOidc ? t('export.exportPasswordModal.placeholderOidc') : t('export.exportPasswordModal.placeholderLocal')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && exportPassword) {
                runExport(exportPassword);
              }
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setExportPasswordPrompt(false);
                setExportPassword('');
              }}
              disabled={isExporting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => runExport(exportPassword)}
              disabled={isExporting || !exportPassword}
            >
              {isExporting ? t('export.exportPasswordModal.encryptingButton') : t('export.exportPasswordModal.downloadButton')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={restoreResult !== null}
        onClose={() => setRestoreResult(null)}
        maxWidth="md"
      >
        {restoreResult && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('restoreResult.title')}
              </h2>
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {t('restoreResult.description')}
            </p>

            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 max-h-64 overflow-y-auto">
              <dl className="space-y-1">
                {Object.entries(restoreResult.restored)
                  .filter(([, count]) => count > 0)
                  .map(([key, count]) => (
                    <div key={key} className="flex justify-between text-sm">
                      <dt className="text-gray-600 dark:text-gray-400">
                        {RESTORE_LABELS[key] ?? key}
                      </dt>
                      <dd className="font-medium text-gray-900 dark:text-white">
                        {count.toLocaleString()}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>

            <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600 flex justify-between text-sm font-medium">
              <span className="text-gray-900 dark:text-white">{t('restoreResult.totalRecords')}</span>
              <span className="text-gray-900 dark:text-white">
                {Object.values(restoreResult.restored).reduce((sum, n) => sum + n, 0).toLocaleString()}
              </span>
            </div>

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setRestoreResult(null)}>
                {t('restoreResult.doneButton')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
