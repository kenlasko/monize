'use client';

import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ParsedQifMultiAccountResponse, DateFormat, DATE_FORMAT_OPTIONS } from '@/lib/import';
import { ImportStep } from '@/app/import/import-utils';

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
}: MultiAccountReviewStepProps) {
  const { categoryDefs, tagDefs = [], accounts, totalTransactionCount } = multiAccountData;
  const incomeCategories = categoryDefs.filter((c) => c.isIncome);
  const expenseCategories = categoryDefs.filter((c) => !c.isIncome);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold text-foreground mb-1">
        Multi-Account QIF Import
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        This file contains {accounts.length} account{accounts.length !== 1 ? 's' : ''},{' '}
        {categoryDefs.length} categor{categoryDefs.length !== 1 ? 'ies' : 'y'}
        {tagDefs.length > 0 && (<>, {tagDefs.length} tag{tagDefs.length !== 1 ? 's' : ''}</>)}
        , and {totalTransactionCount} transaction{totalTransactionCount !== 1 ? 's' : ''}.
        Categories, accounts{tagDefs.length > 0 ? ', tags,' : ''} and transactions will be created automatically.
      </p>

      {/* Settings */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Currency for New Accounts
          </label>
          <Select
            value={currencyCode}
            onChange={(e) => onCurrencyChange(e.target.value)}
            options={currencyOptions}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Date Format
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
          Accounts ({accounts.length})
        </h3>
        <div className="bg-card border border-border rounded-lg divide-y divide-border">
          {accounts.map((acc, i) => (
            <div key={i} className="flex justify-between items-center px-4 py-2">
              <div>
                <span className="text-sm font-medium text-foreground">{acc.accountName}</span>
                <span className="ml-2 text-xs text-muted-foreground">({acc.accountType})</span>
              </div>
              <div className="text-right">
                <span className="text-sm text-muted-foreground">
                  {acc.transactionCount} transaction{acc.transactionCount !== 1 ? 's' : ''}
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
            Categories ({categoryDefs.length})
          </h3>
          <div className="bg-card border border-border rounded-lg p-4">
            {expenseCategories.length > 0 && (
              <div className="mb-3">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Expense ({expenseCategories.length})
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
                  Income ({incomeCategories.length})
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
            Tags ({tagDefs.length})
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
          Sample dates: {multiAccountData.sampleDates.join(', ')} (detected as {multiAccountData.detectedDateFormat})
        </div>
      )}

      {/* Securities notice */}
      {hasSecuritiesToMap && (
        <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            This file contains {multiAccountData.securities.length} securit{multiAccountData.securities.length !== 1 ? 'ies' : 'y'} that need to be mapped before import.
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
          Back
        </Button>
        {hasSecuritiesToMap ? (
          <Button onClick={() => setStep('mapSecurities')}>
            Next: Map Securities
          </Button>
        ) : (
          <Button
            onClick={onImport}
            isLoading={isLoading}
          >
            Import All
          </Button>
        )}
      </div>
    </div>
  );
}
