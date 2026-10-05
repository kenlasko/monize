'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { ImportResult } from '@/lib/import';
import { Account } from '@/types/account';
import { ImportFileData, BulkImportResult } from '@/app/import/import-utils';
import { LoanPaymentSetupDialog } from '@/components/accounts/LoanPaymentSetupDialog';
import { mortgageTypeOf } from '@/lib/mortgage-type';

interface CompleteStepProps {
  importFiles: ImportFileData[];
  isBulkImport: boolean;
  fileName: string;
  selectedAccountId: string;
  accounts: Account[];
  importResult: ImportResult | null;
  bulkImportResult: BulkImportResult | null;
  onImportMore: () => void;
}

export function CompleteStep({
  importFiles,
  isBulkImport,
  fileName,
  selectedAccountId,
  accounts,
  importResult,
  bulkImportResult,
  onImportMore,
}: CompleteStepProps) {
  const t = useTranslations('import');
  const router = useRouter();
  const hasInvestmentFile = importFiles.some((f) => f.parsedData.accountType === 'INVESTMENT');

  // Loan payment setup state
  const [setupDialogAccount, setSetupDialogAccount] = useState<{
    accountId: string;
    accountName: string;
    accountType: string;
    currencyCode?: string;
  } | null>(null);
  const [completedSetups, setCompletedSetups] = useState<Set<string>>(new Set());

  // The mortgage type of a matched account, read from the accounts list rather
  // than from the import summary, which never carried it, through
  // `mortgageTypeOf`, so the dialog seeds the convention the server prices.
  const mortgageTypeOfAccount = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    return account ? mortgageTypeOf(account) : undefined;
  };

  // Collect loan accounts needing setup from import results
  const loanAccountsNeedingSetup = useMemo(() => {
    const seen = new Set<string>();
    const loanAccounts: Array<{
      accountId: string;
      accountName: string;
      accountType: string;
      currencyCode?: string;
    }> = [];

    const addAccounts = (items?: Array<{ accountId: string; accountName: string; accountType: string; currencyCode?: string }>) => {
      if (!items) return;
      for (const la of items) {
        if (!seen.has(la.accountId)) {
          seen.add(la.accountId);
          loanAccounts.push(la);
        }
      }
    };

    if (importResult) {
      addAccounts(importResult.loanAccountsNeedingSetup);
    }
    if (bulkImportResult) {
      addAccounts(bulkImportResult.loanAccountsNeedingSetup);
      for (const fileResult of bulkImportResult.fileResults) {
        addAccounts(fileResult.loanAccountsNeedingSetup);
      }
    }

    return loanAccounts;
  }, [importResult, bulkImportResult]);

  const pendingSetups = loanAccountsNeedingSetup.filter(
    (la) => !completedSetups.has(la.accountId),
  );

  // The Transactions and Investments pages restore their last-viewed account
  // filter from localStorage, so navigating to a bare path would show a
  // previously-imported account rather than the one just imported (issue #911).
  // Build a destination that pins the filter to the account(s) this import
  // touched -- an explicit URL filter takes precedence over the persisted one.
  const viewDestination = useMemo(() => {
    const seen = new Set<string>();
    const accountIds: string[] = [];
    const addId = (id: string | undefined | null) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        accountIds.push(id);
      }
    };
    // Accounts explicitly targeted by the imported files (single + bulk).
    for (const f of importFiles) addId(f.selectedAccountId);
    addId(selectedAccountId);
    // Multi-account QIF imports create their accounts during import and leave
    // importFiles empty, so fall back to the accounts the import created.
    if (accountIds.length === 0 && importResult?.createdMappings) {
      for (const id of Object.values(importResult.createdMappings.accounts)) addId(id);
    }

    if (hasInvestmentFile) {
      // The Investments page filters by a single brokerage account, so use the
      // first imported investment account to surface its holdings immediately.
      const investmentFile = importFiles.find(
        (f) => f.parsedData?.accountType === 'INVESTMENT' && f.selectedAccountId,
      );
      return investmentFile
        ? `/investments?accountId=${investmentFile.selectedAccountId}`
        : '/investments';
    }

    if (accountIds.length === 0) return '/transactions';

    const params = new URLSearchParams();
    if (accountIds.length === 1) {
      params.set('accountId', accountIds[0]);
    } else {
      params.set('accountIds', accountIds.join(','));
    }
    // A closed account is pruned by the persisted "Show Accounts" toggle, so
    // force it to All to keep the just-imported transactions visible.
    if (accountIds.some((id) => accounts.find((a) => a.id === id)?.isClosed)) {
      params.set('accountStatus', 'all');
    }
    return `/transactions?${params.toString()}`;
  }, [importFiles, selectedAccountId, importResult, hasInvestmentFile, accounts]);

  return (
    <div className={isBulkImport ? "max-w-4xl mx-auto" : "max-w-xl mx-auto"}>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="text-center mb-6">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 mb-4">
            <svg
              className="h-6 w-6 text-green-600 dark:text-green-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('complete.heading')}
          </h2>
        </div>

        {/* Bulk import results */}
        {bulkImportResult && (
          <div className="space-y-4 mb-6">
            {/* Overall summary */}
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">{t('complete.overallSummaryHeading')}</h3>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <li><strong>{t('complete.filesImported')}</strong> {bulkImportResult.fileResults.length}</li>
                <li><strong>{t('complete.totalImported')}</strong> {bulkImportResult.totalImported} {t('complete.totalImportedSuffix')}</li>
                <li><strong>{t('complete.totalSkipped')}</strong> {bulkImportResult.totalSkipped} {t('complete.totalSkippedSuffix')}</li>
                <li><strong>{t('complete.totalErrors')}</strong> {bulkImportResult.totalErrors}</li>
                <li><strong>{t('complete.categoriesCreated')}</strong> {bulkImportResult.categoriesCreated}</li>
                <li><strong>{t('complete.accountsCreated')}</strong> {bulkImportResult.accountsCreated}</li>
                <li><strong>{t('complete.payeesCreated')}</strong> {bulkImportResult.payeesCreated}</li>
                <li><strong>{t('complete.securitiesCreated')}</strong> {bulkImportResult.securitiesCreated}</li>
              </ul>
            </div>

            {/* Per-file results */}
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">{t('complete.perFileResultsHeading')}</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {bulkImportResult.fileResults.map((result, index) => (
                  <div
                    key={index}
                    className={`text-sm p-2 rounded ${
                      result.errors > 0
                        ? 'bg-red-50 dark:bg-red-900/20'
                        : 'bg-green-50 dark:bg-green-900/20'
                    }`}
                  >
                    <p className="font-medium text-gray-900 dark:text-gray-100">{result.fileName}</p>
                    <p className="text-gray-600 dark:text-gray-400">
                      {'\u2192'} {result.accountName}: {result.imported} {t('complete.importedSuffix')}, {result.skipped} {t('complete.totalSkippedSuffix')}
                      {result.errors > 0 && <span className="text-red-600 dark:text-red-400">, {result.errors} {t('complete.errorsLabel')}</span>}
                    </p>
                    {result.errorMessages.length > 0 && (
                      <ul className="text-xs text-red-500 dark:text-red-400 mt-1">
                        {result.errorMessages.slice(0, 3).map((msg, i) => (
                          <li key={i}>{msg}</li>
                        ))}
                        {result.errorMessages.length > 3 && (
                          <li>{t('complete.andMoreErrors', { count: result.errorMessages.length - 3 })}</li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Single file import result */}
        {importResult && !bulkImportResult && (
          <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
            <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>
                <strong>{t('complete.fileLabel')}</strong> {fileName}
              </li>
              <li>
                <strong>{t('complete.targetAccount')}</strong> {accounts.find(a => a.id === selectedAccountId)?.name || 'Unknown'}
              </li>
              <li>
                <strong>{t('complete.imported')}</strong> {importResult.imported} {t('complete.importedSuffix')}
              </li>
              <li>
                <strong>{t('complete.skipped')}</strong> {importResult.skipped} {t('complete.skippedSuffix')}
              </li>
              <li>
                <strong>{t('complete.errors')}</strong> {importResult.errors}
              </li>
              <li>
                <strong>{t('complete.categoriesCreated')}</strong> {importResult.categoriesCreated}
              </li>
              <li>
                <strong>{t('complete.accountsCreated')}</strong> {importResult.accountsCreated}
              </li>
              <li>
                <strong>{t('complete.payeesCreated')}</strong> {importResult.payeesCreated}
              </li>
              <li>
                <strong>{t('complete.securitiesCreated')}</strong> {importResult.securitiesCreated}
              </li>
            </ul>
            {importResult.errorMessages.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                  {t('complete.errorsLabel')}
                </p>
                <ul className="text-xs text-red-500 dark:text-red-400 space-y-1 max-h-32 overflow-y-auto">
                  {importResult.errorMessages.map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Loan/Mortgage payment setup prompt */}
        {pendingSetups.length > 0 && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-6">
            <h3 className="font-medium text-amber-900 dark:text-amber-200 mb-2">
              {t('complete.loanSetupHeading')}
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
              {t('complete.loanSetupDescription')}
            </p>
            <div className="space-y-2">
              {pendingSetups.map((la) => (
                <div
                  key={la.accountId}
                  className="flex items-center justify-between bg-white dark:bg-gray-800 rounded p-3"
                >
                  <div>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {la.accountName}
                    </span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 capitalize">
                      {la.accountType.toLowerCase().replace('_', ' ')}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setSetupDialogAccount(la)}
                  >
                    {t('complete.setUpPayments')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Show completion message for already-setup accounts */}
        {completedSetups.size > 0 && (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 mb-6">
            <p className="text-sm text-green-800 dark:text-green-300">
              {t('complete.scheduledPaymentsConfigured', { count: completedSetups.size, plural: completedSetups.size > 1 ? 's' : '' })}
            </p>
          </div>
        )}

        <div className="flex justify-center space-x-4">
          <Button
            variant="outline"
            onClick={() => router.push(viewDestination)}
          >
            {hasInvestmentFile ? t('complete.viewInvestments') : t('complete.viewTransactions')}
          </Button>
          <Button onClick={onImportMore}>
            {t('complete.importMoreFiles')}
          </Button>
        </div>
      </div>

      {/* Loan payment setup dialog */}
      {setupDialogAccount && (
        <LoanPaymentSetupDialog
          isOpen={true}
          onClose={() => setSetupDialogAccount(null)}
          loanAccount={{
            ...setupDialogAccount,
            // The dialog submits its own type select, so an unseeded `ANNUITY`
            // on a matched existing Canadian fixed-rate mortgage turns
            // semi-annual compounding off for every future split. The import
            // list carries only what the import knew, so the type is read from
            // the account itself.
            mortgageType: mortgageTypeOfAccount(setupDialogAccount.accountId),
          }}
          accounts={accounts}
          onSetupComplete={() => {
            setCompletedSetups((prev) => new Set([...prev, setupDialogAccount.accountId]));
          }}
        />
      )}
    </div>
  );
}
