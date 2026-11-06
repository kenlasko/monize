'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import {
  CategoryMapping,
  AccountMapping,
  SecurityMapping,
  ParsedQifResponse,
  CsvInvestmentSummary,
  CanonicalInvestmentAction,
  CANONICAL_INVESTMENT_ACTIONS,
} from '@/lib/import';
import { Account } from '@/types/account';
import { ImportFileData, ImportStep } from '@/app/import/import-utils';
import { UnreadableDatesNotice } from './UnreadableDatesNotice';

/** Merge the per-file investment summaries of a (possibly bulk) CSV parse. */
function combineInvestmentSummaries(files: ImportFileData[]): CsvInvestmentSummary | null {
  const summaries = files
    .map((f) => f.parsedData?.investmentSummary)
    .filter((s): s is CsvInvestmentSummary => !!s);
  if (summaries.length === 0) return null;

  const actionCounts: Partial<Record<CanonicalInvestmentAction, number>> = {};
  const cashFallbackValues = new Set<string>();
  const rejectedByReason = new Map<string, number>();
  let uncostedShareRows = 0;
  for (const s of summaries) {
    for (const [action, count] of Object.entries(s.actionCounts)) {
      const key = action as CanonicalInvestmentAction;
      actionCounts[key] = (actionCounts[key] || 0) + (count || 0);
    }
    s.cashFallbackValues.forEach((v) => cashFallbackValues.add(v));
    uncostedShareRows += s.uncostedShareRows;
    for (const r of s.rejectedRows) {
      rejectedByReason.set(r.reason, (rejectedByReason.get(r.reason) || 0) + r.count);
    }
  }
  return {
    actionCounts,
    cashFallbackValues: Array.from(cashFallbackValues).sort(),
    uncostedShareRows,
    rejectedRows: Array.from(rejectedByReason.entries()).map(([reason, count]) => ({ reason, count })),
  };
}

interface ReviewStepProps {
  importFiles: ImportFileData[];
  isBulkImport: boolean;
  fileName: string;
  parsedData: ParsedQifResponse | null;
  selectedAccountId: string;
  accounts: Account[];
  categoryMappings: CategoryMapping[];
  accountMappings: AccountMapping[];
  securityMappings: SecurityMapping[];
  shouldShowMapAccounts: boolean;
  isLoading: boolean;
  handleImport: () => void;
  setStep: (step: ImportStep) => void;
}

export function ReviewStep({
  importFiles,
  isBulkImport,
  fileName,
  parsedData,
  selectedAccountId,
  accounts,
  categoryMappings,
  accountMappings,
  securityMappings,
  shouldShowMapAccounts,
  isLoading,
  handleImport,
  setStep,
}: ReviewStepProps) {
  const t = useTranslations('import');
  const mappedCategories = categoryMappings.filter((m) => m.categoryId || m.createNew).length;
  const newCategories = categoryMappings.filter((m) => m.createNew).length;
  const loanCategories = categoryMappings.filter((m) => m.isLoanCategory).length;
  const newLoanAccounts = categoryMappings.filter((m) => m.isLoanCategory && m.createNewLoan).length;
  const mappedAccounts = accountMappings.filter((m) => m.accountId || m.createNew).length;
  const newAccounts = accountMappings.filter((m) => m.createNew).length;
  const mappedSecuritiesCount = securityMappings.filter((m) => m.securityId || m.createNew).length;
  const newSecuritiesCount = securityMappings.filter((m) => m.createNew).length;
  const totalTransactions = importFiles.reduce((sum, f) => sum + f.parsedData.transactionCount, 0);
  const investmentSummary = combineInvestmentSummaries(importFiles);
  const totalRejected = investmentSummary
    ? investmentSummary.rejectedRows.reduce((sum, r) => sum + r.count, 0)
    : 0;

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('review.heading')}
        </h2>
        <div className="space-y-4">
          <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
            <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
              {isBulkImport ? t('review.filesHeading') : t('review.summaryHeading')}
            </h3>
            {isBulkImport ? (
              <div className="space-y-2">
                {importFiles.map((fileData, index) => {
                  const targetAcc = accounts.find((a) => a.id === fileData.selectedAccountId);
                  return (
                    <div key={index} className="text-sm text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600 pb-2 last:border-0">
                      <p><strong>{fileData.fileName}</strong></p>
                      <p className="ml-4">
                        {fileData.parsedData.transactionCount} transactions {t('review.arrow')} {targetAcc?.name}
                      </p>
                    </div>
                  );
                })}
                <div className="pt-2 text-sm text-gray-600 dark:text-gray-400">
                  <strong>{t('review.totalLabel')}</strong> {importFiles.length} files, {totalTransactions} transactions
                </div>
              </div>
            ) : (
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <li>
                  <strong>{t('review.fileLabel')}</strong> {fileName}
                </li>
                <li>
                  <strong>{t('review.transactionsToImport')}</strong> {parsedData?.transactionCount}
                </li>
                <li>
                  <strong>{t('review.targetAccount')}</strong> {accounts.find((a) => a.id === selectedAccountId)?.name}
                </li>
              </ul>
            )}
          </div>

          <UnreadableDatesNotice importFiles={importFiles} showFileNames={isBulkImport} />

          {categoryMappings.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('review.categoriesHeading')}
              </h3>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <li>
                  <strong>{t('review.totalCategories')}</strong> {categoryMappings.length}
                </li>
                <li>
                  <strong>{t('review.mappedToCategories')}</strong> {mappedCategories}
                </li>
                <li>
                  <strong>{t('review.newCategoriesToCreate')}</strong> {newCategories}
                </li>
                {loanCategories > 0 && (
                  <>
                    <li>
                      <strong>{t('review.mappedToLoans')}</strong> {loanCategories}
                    </li>
                    {newLoanAccounts > 0 && (
                      <li>
                        <strong>{t('review.newLoanAccounts')}</strong> {newLoanAccounts}
                      </li>
                    )}
                  </>
                )}
              </ul>
            </div>
          )}

          {accountMappings.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('review.transferAccountsHeading')}
              </h3>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <li>
                  <strong>{t('review.totalAccounts')}</strong> {accountMappings.length}
                </li>
                <li>
                  <strong>{t('review.mappedAccounts')}</strong> {mappedAccounts}
                </li>
                <li>
                  <strong>{t('review.newToCreate')}</strong> {newAccounts}
                </li>
              </ul>
            </div>
          )}

          {securityMappings.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('review.securitiesHeading')}
              </h3>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <li>
                  <strong>{t('review.totalSecurities')}</strong> {securityMappings.length}
                </li>
                <li>
                  <strong>{t('review.mappedSecurities')}</strong> {mappedSecuritiesCount}
                </li>
                <li>
                  <strong>{t('review.newSecurities')}</strong> {newSecuritiesCount}
                </li>
              </ul>
            </div>
          )}

          {investmentSummary && (
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('review.investmentHeading')}
              </h3>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                {CANONICAL_INVESTMENT_ACTIONS.filter((a) => (investmentSummary.actionCounts[a] || 0) > 0).map((action) => (
                  <li key={action}>
                    <strong>{t(`csvMapping.actionNames.${action}` as Parameters<typeof t>[0])}:</strong> {investmentSummary.actionCounts[action]}
                  </li>
                ))}
              </ul>
              {investmentSummary.cashFallbackValues.length > 0 && (
                <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                  {t('review.cashFallbackNotice', { values: investmentSummary.cashFallbackValues.join(', ') })}
                </p>
              )}
              {investmentSummary.uncostedShareRows > 0 && (
                <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                  {t('review.uncostedNotice', { count: investmentSummary.uncostedShareRows })}
                </p>
              )}
              {totalRejected > 0 && (
                <div className="mt-2 text-sm text-red-600 dark:text-red-400 space-y-1">
                  <p>{t('review.rejectedNotice', { count: totalRejected })}</p>
                  <ul className="ml-4 list-disc">
                    {investmentSummary.rejectedRows.map((r) => (
                      <li key={r.reason}>
                        {t(`review.rejectedReasons.${r.reason}` as Parameters<typeof t>[0])}: {r.count}
                      </li>
                    ))}
                  </ul>
                  <p>{t('review.rejectedGoBack')}</p>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-between mt-6">
          <Button
            variant="outline"
            onClick={() => {
              if (shouldShowMapAccounts) {
                setStep('mapAccounts');
              } else if (securityMappings.length > 0) {
                setStep('mapSecurities');
              } else if (categoryMappings.length > 0) {
                setStep('mapCategories');
              } else {
                setStep('selectAccount');
              }
            }}
          >
            {t('navigation.back')}
          </Button>
          <Button onClick={handleImport} isLoading={isLoading}>
            {t('review.importButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
