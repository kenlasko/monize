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
import { downloadBlob } from '@/lib/download';
import { User } from '@/types/auth';
import { takeOidcReauthArtifact } from '@/lib/stepUpToken';

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
  // Whether the download has to be encrypted is not known until the status
  // arrives; exporting before then could produce a plaintext file for a user
  // whose backups are encrypted.
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

  // Backup password setup. Only reachable for an account the server reports as
  // manageable: a local-auth user's backups are encrypted with the login
  // password it captured at sign-in, so there is nothing here for them.
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
        // A failed status read is not "encryption off": exporting on that
        // assumption would download a plaintext copy of everything. Leave it
        // null so the export button stays disabled.
        if (!cancelled) setEncryption(null);
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
      const {
        blob,
        complete,
        expectedAttachments,
        includedAttachments,
        missingAttachments,
        inconsistentAttachments,
      } = await backupApi.exportBackup(encryptionPassword);
      // Date the filename by the user's configured timezone preference, not UTC
      // or the browser's timezone. `toISOString()` renders in UTC (an evening
      // export in a negative-offset zone would be stamped with tomorrow), and
      // the browser's own timezone can differ from the preference the user set
      // in Settings (e.g. an Australia/Sydney preference viewed from US/Eastern).
      const today = getDateStringInTimezone(resolveTimezone(timezonePref));
      const extension = encryptionPassword ? 'mzbe' : 'json.gz';
      // An incomplete artifact is named as one on disk, matching what the server
      // put in Content-Disposition: a toast is gone in five seconds, a filename
      // is still there when somebody reaches for this file in a crisis.
      const filename = complete
        ? `monize-backup-${today}.${extension}`
        : `monize-backup-${today}-INCOMPLETE.${extension}`;
      downloadBlob(blob, filename);

      if (complete) {
        toast.success(t('export.toasts.success'));
      } else {
        // Deliberately not a success toast. The server could not include every
        // attachment it named, so calling this a successful backup is how a user
        // ends up deleting the source system for an artifact that cannot restore
        // it.
        // Both failure modes count: absent bytes and bytes that contradict their
        // own metadata are equally unrestorable, and the backend excludes both
        // from `includedAttachments`. Reporting only `missing` said "0 of 1" for
        // an artifact with one corrupt attachment -- a false number pointing at
        // the wrong cause. The breakdown keeps the diagnosis.
        toast.error(
          t('export.toasts.incomplete', {
            // Everything the server could not include, taken from its
            // authoritative included count rather than re-summing the known
            // exclusion reasons -- so a future exclusion the breakdown does not
            // name still counts here.
            unusable: expectedAttachments - includedAttachments,
            total: expectedAttachments,
            missing: missingAttachments,
            inconsistent: inconsistentAttachments,
          }),
          { duration: 12000 },
        );
      }
      setExportPasswordPrompt(false);
      setExportPassword('');
    } catch (error) {
      toast.error(getErrorMessage(error, t('export.toasts.failed')));
    } finally {
      setIsExporting(false);
    }
  };

  const handleExport = async () => {
    if (!encryption) return;
    if (encryption.enabled) {
      // Open the modal to capture the encryption password. Cleaner than
      // pre-populating any field: forces explicit confirmation that the
      // password the user is about to type matches their stored one.
      setExportPasswordPrompt(true);
      return;
    }
    await runExport();
  };

  const closeEncryptionSetup = () => {
    setShowEncryptionSetup(false);
    setSetupPassword('');
  };

  const handleSetBackupPassword = async () => {
    setSetupSaving(true);
    try {
      await backupApi.setBackupPassword(setupPassword);
      setEncryption(await backupApi.getEncryptionStatus());
      closeEncryptionSetup();
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
      setEncryption(await backupApi.getEncryptionStatus());
      toast.success(t('encryption.toasts.disabled'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('encryption.toasts.disableFailed')));
    }
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
      let authData: { oidcIdToken?: string; password?: string };
      if (isOidc) {
        // Real re-authentication, not a claim that one happened. The redirect
        // loses the selected file, so say so -- the user re-picks it on return and
        // the artifact is waiting.
        const artifact = takeOidcReauthArtifact('restore-backup', '/settings');
        if (!artifact) {
          toast.success(t('restore.toasts.reauthRedirect'));
          return;
        }
        authData = { oidcIdToken: artifact };
      } else {
        authData = { password: restorePassword };
      }

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

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6">
        {t('heading')}
      </h2>

      {/* Backup password -- OIDC accounts only. A local-auth account's backups
          are encrypted with the login password the server captured at sign-in,
          so there is nothing to set, change or switch off. */}
      {encryption?.manageable && (
        <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
            {t('encryption.heading')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('encryption.descriptionOidc')}
          </p>

          {encryption.enabled ? (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                {t('encryption.enabledBadge')}
              </span>
              <Button
                variant="outline"
                onClick={() => setShowEncryptionSetup(true)}
              >
                {t('encryption.changePasswordButton')}
              </Button>
              <Button variant="outline" onClick={handleDisableEncryption}>
                {t('encryption.disableButton')}
              </Button>
            </div>
          ) : (
            <Button onClick={() => setShowEncryptionSetup(true)}>
              {t('encryption.setPasswordButton')}
            </Button>
          )}
        </div>
      )}

      {encryptionLoading && (
        <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
          {t('encryption.loading')}
        </p>
      )}

      {/* Export Section */}
      <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('export.heading')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t('export.description')}
        </p>
        <Button
          onClick={handleExport}
          disabled={isExporting || encryptionLoading || !encryption}
        >
          {isExporting ? t('export.creatingButton') : t('export.downloadButton')}
        </Button>
      </div>

      {/* Restore Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
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
                  // The artifact's own password, not a credential of this site:
                  // an autofilled login password here just fails to decrypt.
                  autoComplete="off"
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
                    autoComplete="current-password"
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

      {/* Backup password modal */}
      <Modal
        isOpen={showEncryptionSetup}
        onClose={closeEncryptionSetup}
        maxWidth="sm"
      >
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('encryption.setupModal.titleOidc')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('encryption.setupModal.descriptionOidc')}
          </p>
          <Input
            type="password"
            autoComplete="new-password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            placeholder={t('encryption.setupModal.placeholderOidc')}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={closeEncryptionSetup}
              disabled={setupSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSetBackupPassword}
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
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('export.exportPasswordModal.title')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('export.exportPasswordModal.description')}
          </p>
          <Input
            type="password"
            // Encrypts the file being produced; a manager filling this with the
            // site login would encrypt the backup under a password nobody knows.
            autoComplete="off"
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
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
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
                      <dd className="font-medium text-gray-900 dark:text-gray-100">
                        {count.toLocaleString()}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>

            <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600 flex justify-between text-sm font-medium">
              <span className="text-gray-900 dark:text-gray-100">{t('restoreResult.totalRecords')}</span>
              <span className="text-gray-900 dark:text-gray-100">
                {Object.values(restoreResult.restored).reduce((sum, n) => sum + n, 0).toLocaleString()}
              </span>
            </div>

            {/* Attachments whose bytes could not be found are not restored, and
                a success dialogue that says nothing about them leaves the user
                believing files came back that did not. Reported outside the
                record total on purpose: they were not written. */}
            {!!restoreResult.skippedAttachments && (
              <p className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
                {t('restoreResult.skippedAttachments', {
                  count: restoreResult.skippedAttachments,
                })}
              </p>
            )}

            {/* The provider rows came back; the API keys inside them did not,
                because the key that encrypts them is server configuration and
                never travels in a backup. Nothing else says so -- the provider
                list shows a masked key either way -- so a silent success here
                leaves the user with AI features that fail for no visible
                reason. */}
            {!!restoreResult.unusableAiProviderKeys && (
              <p className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
                {t('restoreResult.unusableAiProviderKeys', {
                  count: restoreResult.unusableAiProviderKeys,
                })}
              </p>
            )}

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
