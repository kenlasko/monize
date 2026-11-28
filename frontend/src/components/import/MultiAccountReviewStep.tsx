'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ParsedQifMultiAccountResponse, DateFormat, DATE_FORMAT_OPTIONS } from '@/lib/import';
import { ImportStep } from '@/app/import/import-utils';
import { UnreadableAmountsNotice } from './UnreadableAmountsNotice';

interface MultiAccountReviewStepProps {
  multiAccountData: ParsedQifMultiAccountResponse;
  currencyCode: string;
  onCurrencyChange: (code: string) => void;
  currencyOptions: Array<{ value: string; label: string }>;
  dateFormat: DateFormat;
  onDateFormatChange: (format: DateFormat) => void;
  isLoading: boolean;
  onImport: () => void;
  setStep: (step: ImportStep) => void;
  hasSecuritiesToMap: boolean;
  /** The user's type, by account name, for each account the file leaves untyped. */
  accountTypeChoices: Record<string, string>;
  onAccountTypeChoiceChange: (accountName: string, accountType: string) => void;
  accountTypeOptions: Array<{ value: string; label: string }>;
}

export function MultiAccountReviewStep({
  multiAccountData,
  currencyCode,
  onCurrencyChange,
  currencyOptions,
  dateFormat,
  onDateFormatChange,
  isLoading,
  onImport,
  setStep,
  hasSecuritiesToMap,
  accountTypeChoices,
  onAccountTypeChoiceChange,
  accountTypeOptions,
}: MultiAccountReviewStepProps) {
  const t = useTranslations('import');
  const { categoryDefs, tagDefs = [], accounts, totalTransactionCount } = multiAccountData;
  // income-flag-ok: the parsed file's own income/expense flag
  const incomeCategories = categoryDefs.filter((c) => c.isIncome);
  // income-flag-ok: the parsed file's own income/expense flag
  const expenseCategories = categoryDefs.filter((c) => !c.isIncome);
  // The file names no type for these; the import is not offered until the
  // user has chosen one for each, rather than assume chequing.
  const untypedAccountNames = [
    ...new Set(
      accounts
        .filter((acc) => acc.accountName && acc.accountType === null)
        .map((acc) => acc.accountName),
    ),
  ];
  const typesStillNeeded = untypedAccountNames.filter((name) => !accountTypeChoices[name]).length;
  const chooseTypeOptions = [
    { value: '', label: t('multiAccountReview.chooseAccountType') },
    ...accountTypeOptions,
  ];

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold text-foreground mb-1">
        {t('multiAccountReview.heading')}
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        {t('multiAccountReview.description', {
          accounts: accounts.length,
          accountsPlural: accounts.length !== 1 ? 's' : '',
          categories: categoryDefs.length,
          categoriesPlural: categoryDefs.length !== 1 ? 'ies' : 'y',
          tagsSection: tagDefs.length > 0 ? t('multiAccountReview.tagsSection', { count: tagDefs.length, tagsPlural: tagDefs.length !== 1 ? 's' : '' }) : '',
          transactions: totalTransactionCount,
          transactionsPlural: totalTransactionCount !== 1 ? 's' : '',
          tagsCreated: tagDefs.length > 0 ? t('multiAccountReview.tagsCreated') : '',
        })}
      </p>

      {(multiAccountData.unreadableAmounts?.count ?? 0) > 0 && (
        <div className="mb-6">
          <UnreadableAmountsNotice
            importFiles={[{ fileName: '', fileType: 'qif', parsedData: multiAccountData }]}
            showFileNames={false}
          />
        </div>
      )}

      {/* Settings */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('multiAccountReview.currencyForNewAccounts')}
          </label>
          <Select
            value={currencyCode}
            onChange={(e) => onCurrencyChange(e.target.value)}
            options={currencyOptions}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('multiAccountReview.dateFormat')}
          </label>
          <Select
            value={dateFormat}
            onChange={(e) => onDateFormatChange(e.target.value as DateFormat)}
            options={DATE_FORMAT_OPTIONS}
          />
        </div>
      </div>

      {/* Accounts */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t('multiAccountReview.accountsHeading', { count: accounts.length })}
        </h3>
        <div className="bg-card border border-border rounded-lg divide-y divide-border">
          {accounts.map((acc, i) => (
            <div key={i} className="flex justify-between items-center px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{acc.accountName}</span>
                {acc.accountType === null && acc.accountName ? (
                  <div className="w-44">
                    <Select
                      aria-label={t('multiAccountReview.accountTypeFor', { name: acc.accountName })}
                      value={accountTypeChoices[acc.accountName] ?? ''}
                      onChange={(e) => onAccountTypeChoiceChange(acc.accountName, e.target.value)}
                      options={chooseTypeOptions}
                      className="py-1 text-xs"
                    />
                  </div>
                ) : (
                  acc.accountType !== null && (
                    <span className="text-xs text-muted-foreground">({acc.accountType})</span>
                  )
                )}
              </div>
              <div className="text-right">
                <span className="text-sm text-muted-foreground">
                  {t('multiAccountReview.transactionCount', { count: acc.transactionCount, plural: acc.transactionCount !== 1 ? 's' : '' })}
                </span>
                {acc.dateRange.start && (
                  <span className="text-xs text-muted-foreground ml-2">
                    {acc.dateRange.start} to {acc.dateRange.end}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Categories */}
      {categoryDefs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            {t('multiAccountReview.categoriesHeading', { count: categoryDefs.length })}
          </h3>
          <div className="bg-card border border-border rounded-lg p-4">
            {expenseCategories.length > 0 && (
              <div className="mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('multiAccountReview.expenseLabel', { count: expenseCategories.length })}
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {expenseCategories.map((cat, i) => (
                    <span
                      key={i}
                      className="inline-block px-2 py-0.5 text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 rounded"
                    >
                      {cat.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {incomeCategories.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('multiAccountReview.incomeLabel', { count: incomeCategories.length })}
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {incomeCategories.map((cat, i) => (
                    <span
                      key={i}
                      className="inline-block px-2 py-0.5 text-xs bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 rounded"
                    >
                      {cat.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tags */}
      {tagDefs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            {t('multiAccountReview.tagsHeading', { count: tagDefs.length })}
          </h3>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex flex-wrap gap-1">
              {tagDefs.map((tag, i) => (
                <span
                  key={i}
                  className="inline-block px-2 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 rounded"
                >
                  {tag.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sample dates */}
      {multiAccountData.sampleDates.length > 0 && (
        <div className="mb-6 text-xs text-muted-foreground">
          {t('multiAccountReview.sampleDates', { dates: multiAccountData.sampleDates.join(', '), format: multiAccountData.detectedDateFormat })}
        </div>
      )}

      {/* Account types the file does not name */}
      {typesStillNeeded > 0 && (
        <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t('multiAccountReview.accountTypesNeeded', { count: typesStillNeeded })}
          </p>
        </div>
      )}

      {/* Securities notice */}
      {hasSecuritiesToMap && (
        <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t('multiAccountReview.securitiesNotice', { count: multiAccountData.securities.length, plural: multiAccountData.securities.length !== 1 ? 'ies' : 'y' })}
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-between pt-4">
        <Button
          variant="outline"
          onClick={() => setStep('upload')}
          disabled={isLoading}
        >
          {t('navigation.back')}
        </Button>
        {hasSecuritiesToMap ? (
          <Button onClick={() => setStep('mapSecurities')} disabled={typesStillNeeded > 0}>
            {t('multiAccountReview.nextMapSecurities')}
          </Button>
        ) : (
          <Button
            onClick={onImport}
            isLoading={isLoading}
            disabled={typesStillNeeded > 0}
          >
            {t('multiAccountReview.importAll')}
          </Button>
        )}
      </div>
    </div>
  );
}
