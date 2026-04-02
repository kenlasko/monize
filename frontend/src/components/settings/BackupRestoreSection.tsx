'use client';

import { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { backupApi, RestoreResult } from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
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
  securities: 'Securities',
  securityPrices: 'Security Prices',
  holdings: 'Holdings',
  transactions: 'Transactions',
  transactionSplits: 'Transaction Splits',
  transactionTags: 'Transaction Tags',
  transactionSplitTags: 'Transaction Split Tags',
  investmentTransactions: 'Investment Transactions',
  budgets: 'Budgets',
  budgetCategories: 'Budget Categories',
  budgetPeriods: 'Budget Periods',
  budgetPeriodCategories: 'Budget Period Categories',
  budgetAlerts: 'Budget Alerts',
  customReports: 'Custom Reports',
  importColumnMappings: 'Import Column Mappings',
  monthlyAccountBalances: 'Monthly Account Balances',
  autoBackupSettings: 'Auto-Backup Settings',
};

interface BackupRestoreSectionProps {
  user: User;
}

export function BackupRestoreSection({ user }: BackupRestoreSectionProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOidc = user.authProvider === 'oidc';

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const blob = await backupApi.exportBackup();
      const url = URL.createObjectURL(blob);
      const filename = `monize-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success('Backup downloaded successfully');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create backup'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setRestoreFile(file);
  };

  const handleRestore = async () => {
    if (!restoreFile) {
      toast.error('Please select a backup file');
      return;
    }
    if (!isOidc && !restorePassword) {
      toast.error('Please enter your password to confirm');
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
      });

      setRestoreResult(result);

      // Reset form
      setShowRestore(false);
      setRestorePassword('');
      setRestoreFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to restore backup'));
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
        Backup & Restore
      </h2>

      {/* Export Section */}
      <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          Create Backup
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Download a complete backup of your financial data as a JSON file. This includes
          accounts, transactions, categories, payees, budgets, investments, and all other
          user data.
        </p>
        <Button
          onClick={handleExport}
          disabled={isExporting}
        >
          {isExporting ? 'Creating Backup...' : 'Download Backup'}
        </Button>
      </div>

      {/* Restore Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          Restore from Backup
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Replace all your current data with data from a previously exported backup file.
          This will permanently overwrite your existing data.
        </p>

        {!showRestore ? (
          <Button
            variant="outline"
            onClick={() => setShowRestore(true)}
          >
            Restore from Backup...
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
                Warning: This will delete all your current data and replace it with the
                backup contents. This action cannot be undone.
              </p>
            </div>

            <div>
              <label htmlFor="backup-file-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Select backup file
              </label>
              <input
                id="backup-file-input"
                ref={fileInputRef}
                type="file"
                accept=".json,.json.gz,.gz"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-500 dark:text-gray-400
                  file:mr-4 file:py-2 file:px-4 file:rounded file:border-0
                  file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700
                  dark:file:bg-blue-900/30 dark:file:text-blue-300
                  hover:file:bg-blue-100 dark:hover:file:bg-blue-900/50
                  file:cursor-pointer cursor-pointer"
              />
            </div>

            <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300 mb-2">
                {isOidc
                  ? 'Re-authenticate with your identity provider to confirm:'
                  : 'Enter your password to confirm:'}
              </p>
              {isOidc ? (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={handleRestore}
                    disabled={isRestoring || !restoreFile}
                  >
                    {isRestoring ? 'Restoring...' : 'Re-authenticate and Restore'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowRestore(false);
                      setRestoreFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder="Enter your password"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && restorePassword && restoreFile) {
                        handleRestore();
                      }
                    }}
                  />
                  <div className="flex gap-2 mt-3">
                    <Button
                      variant="danger"
                      onClick={handleRestore}
                      disabled={isRestoring || !restorePassword || !restoreFile}
                    >
                      {isRestoring ? 'Restoring...' : 'Confirm Restore'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowRestore(false);
                        setRestorePassword('');
                        setRestoreFile(null);
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
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
                Restore Complete
              </h2>
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Your data has been restored successfully. Here is a summary of what was restored:
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
              <span className="text-gray-900 dark:text-white">Total records</span>
              <span className="text-gray-900 dark:text-white">
                {Object.values(restoreResult.restored).reduce((sum, n) => sum + n, 0).toLocaleString()}
              </span>
            </div>

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setRestoreResult(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
