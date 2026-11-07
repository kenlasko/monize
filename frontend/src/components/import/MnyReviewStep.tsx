'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { HelpLink } from '@/components/help/HelpLink';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { formatAccountType } from '@/lib/account-utils';
import { MnyImportOptionsInput, MnyPreview } from '@/lib/import-mny';
import { mnyErrorDocsLink } from '@/lib/import-mny-error-docs';
import { MnyBillsPanel } from './MnyBillsPanel';
import { MnyWarningsPanel } from './MnyWarningsPanel';
import { Th } from '@/components/ui/Table';

interface MnyReviewStepProps {
  preview: MnyPreview;
  excludedHandles: ReadonlySet<number>;
  currencyOverrides: ReadonlyMap<number, string>;
  /** Bill handles the user has ticked; only these are imported. */
  selectedBillHandles: ReadonlySet<number>;
  options: MnyImportOptionsInput;
  currencyOptions: Array<{ value: string; label: string }>;
  isLoading: boolean;
  /** Why the last Start import attempt did not begin, if it did not. */
  startError: { code?: string; message: string } | null;
  onToggleAccount: (handle: number) => void;
  onSetAllAccounts: (include: boolean) => void;
  onSetAccountCurrency: (handle: number, currencyCode: string | null) => void;
  onToggleBill: (handle: number) => void;
  onSetAllBills: (include: boolean) => void;
  onSetOption: <K extends keyof MnyImportOptionsInput>(
    key: K,
    value: MnyImportOptionsInput[K],
  ) => void;
  onBack: () => void;
  onImport: () => void;
}

/**
 * What the file contains, and what will be done with it.
 *
 * Modelled on `MultiAccountReviewStep`, with one addition that matters: each
 * account shows the **final balance computed from the Money file**. That number
 * is what the verification report reconciles against after the import, so a user
 * can sanity-check it against Money before committing -- the trust-builder both
 * PR #192 testers asked for.
 */
export function MnyReviewStep({
  preview,
  excludedHandles,
  currencyOverrides,
  selectedBillHandles,
  options,
  currencyOptions,
  isLoading,
  startError,
  onToggleAccount,
  onSetAllAccounts,
  onSetAccountCurrency,
  onToggleBill,
  onSetAllBills,
  onSetOption,
  onBack,
  onImport,
}: MnyReviewStepProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  const { formatCurrency } = useNumberFormat();

  const { counts, fileCounts } = preview;
  const includedCount = preview.accounts.filter(
    (account) => account.handle === null || !excludedHandles.has(account.handle),
  ).length;

  return (
    // Wider than the rest of the wizard on purpose: this step carries the
    // account list with its currency selects, the bill checkboxes and the
    // warnings panel, and at max-w-4xl every one of them wraps.
    <div className="max-w-6xl mx-auto">
      <h2 className="text-lg font-semibold text-foreground mb-1">
        {t('mnyReview.heading')}
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        {t('mnyReview.fileSummary', {
          filename: preview.filename,
          era: t(`mnyReview.era.${preview.era}`),
          currency: preview.baseCurrency,
        })}
      </p>

      {/* What this Money version could not supply */}
      {preview.missingTables.length > 0 && (
        <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t('mnyReview.missingTables', {
              tables: preview.missingTables.join(', '),
            })}
          </p>
        </div>
      )}

      {/* Counts */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryTile
          label={t('mnyReview.counts.transactions')}
          value={String(counts.transactionsToCreate)}
          detail={t('mnyReview.counts.transfersLinked', {
            count: counts.transfersToLink,
          })}
        />
        <SummaryTile
          label={t('mnyReview.counts.payees')}
          value={String(counts.payeesToCreate)}
          detail={t('mnyReview.counts.ofTotal', { total: counts.payeesInFile })}
        />
        <SummaryTile
          label={t('mnyReview.counts.categories')}
          value={String(counts.categoriesToCreate)}
          detail={t('mnyReview.counts.ofTotal', {
            total: counts.categoriesInFile,
          })}
        />
        <SummaryTile
          label={t('mnyReview.counts.accounts')}
          value={String(includedCount)}
          detail={t('mnyReview.counts.ofTotal', {
            total: preview.accounts.length,
          })}
        />
        {counts.tagsInFile > 0 && (
          <SummaryTile
            label={t('mnyReview.counts.tags')}
            value={String(counts.tagsToCreate)}
            detail={t('mnyReview.counts.ofTotal', { total: counts.tagsInFile })}
          />
        )}
      </div>

      {/* Investments */}
      {counts.securitiesToCreate > 0 && (
        <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryTile
            label={t('mnyReview.counts.securities')}
            value={String(counts.securitiesToCreate)}
            detail={t('mnyReview.counts.ofTotal', {
              total: counts.securitiesInFile,
            })}
          />
          <SummaryTile
            label={t('mnyReview.counts.investments')}
            value={String(counts.investmentsToCreate)}
            detail={t('mnyReview.counts.investmentDetail', {
              transfers: counts.shareTransfersPaired,
            })}
          />
          <SummaryTile
            label={t('mnyReview.counts.prices')}
            value={String(counts.pricesToImport)}
            detail={t('mnyReview.counts.ofTotal', {
              total: fileCounts.securityPrices,
            })}
          />
          <SummaryTile
            label={t('mnyReview.counts.exchangeRates')}
            value={String(counts.exchangeRatesToImport)}
            detail={t('mnyReview.counts.ofTotal', {
              total: fileCounts.exchangeRates,
            })}
          />
        </div>
      )}

      {/* Bills: how many rows the file holds versus how many are live series */}
      {fileCounts.bills > 0 && (
        <div className="mb-6">
          <SummaryTile
            label={t('mnyReview.counts.bills')}
            value={String(counts.billsDetected)}
            detail={t('mnyReview.counts.billsOfRows', {
              rows: fileCounts.bills,
            })}
          />
        </div>
      )}

      {/* Accounts */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t('mnyReview.accountsHeading', { count: preview.accounts.length })}
          </h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSetAllAccounts(true)}
              className="text-xs text-primary hover:underline"
            >
              {t('mnyReview.selectAll')}
            </button>
            <button
              type="button"
              onClick={() => onSetAllAccounts(false)}
              className="text-xs text-primary hover:underline"
            >
              {t('mnyReview.selectNone')}
            </button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th className="px-3 py-2">
                  {t('mnyReview.table.include')}
                </Th>
                <Th className="px-3 py-2">
                  {t('mnyReview.table.account')}
                </Th>
                <Th className="px-3 py-2">
                  {t('mnyReview.table.type')}
                </Th>
                <Th className="px-3 py-2">
                  {t('mnyReview.table.currency')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyReview.table.transactions')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyReview.table.openingBalance')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyReview.table.finalBalance')}
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.accounts.map((account) => {
                const handle = account.handle;
                const included =
                  handle === null || !excludedHandles.has(handle);
                const currency =
                  (handle !== null ? currencyOverrides.get(handle) : null) ??
                  account.currencyCode;

                return (
                  <tr
                    key={account.key}
                    className={included ? '' : 'opacity-50'}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={handle === null}
                        onChange={() => handle !== null && onToggleAccount(handle)}
                        aria-label={t('mnyReview.table.includeAccount', {
                          name: account.name,
                        })}
                        className="rounded border-border"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-foreground">
                        {account.name}
                      </span>
                      {account.closed && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 rounded">
                          {t('mnyReview.table.closed')}
                        </span>
                      )}
                      {account.favourite && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 rounded">
                          {t('mnyReview.table.favourite')}
                        </span>
                      )}
                      {account.excludeFromNetWorth && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 rounded">
                          {t('mnyReview.table.excludedFromNetWorth')}
                        </span>
                      )}
                      {account.name !== account.moneyName && (
                        <span className="block text-xs text-muted-foreground">
                          {t('mnyReview.table.renamedFrom', {
                            name: account.moneyName,
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatAccountType(account.accountType, tc)}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={currency}
                        onChange={(e) =>
                          handle !== null &&
                          onSetAccountCurrency(
                            handle,
                            e.target.value === account.currencyCode
                              ? null
                              : e.target.value,
                          )
                        }
                        options={currencyOptions}
                        disabled={handle === null || !included}
                        aria-label={t('mnyReview.table.currencyForAccount', {
                          name: account.name,
                        })}
                        className="text-xs"
                      />
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {account.transactionCount}
                      {account.investmentCount > 0 && (
                        <span className="block text-xs">
                          {t('mnyReview.table.investmentRows', {
                            count: account.investmentCount,
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatCurrency(account.openingBalance, currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-foreground">
                      {formatCurrency(account.finalBalance, currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bills the import will create, ticked individually */}
      <MnyBillsPanel
        bills={preview.bills}
        selectedHandles={selectedBillHandles}
        unsupported={preview.missingTables.includes('BILL')}
        skipped={counts.billsSkipped}
        onToggleBill={onToggleBill}
        onSetAllBills={onSetAllBills}
      />

      {/* Options */}
      <div className="mb-6 bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">
          {t('mnyReview.optionsHeading')}
        </h3>
        <div className="space-y-2">
          <OptionCheckbox
            label={t('mnyReview.options.referencedOnlyPayees')}
            hint={t('mnyReview.options.referencedOnlyPayeesHint')}
            checked={options.referencedOnlyPayees ?? true}
            onChange={(value) => onSetOption('referencedOnlyPayees', value)}
          />
          <OptionCheckbox
            label={t('mnyReview.options.referencedOnlyCategories')}
            hint={t('mnyReview.options.referencedOnlyCategoriesHint')}
            checked={options.referencedOnlyCategories ?? true}
            onChange={(value) => onSetOption('referencedOnlyCategories', value)}
          />
          <OptionCheckbox
            label={t('mnyReview.options.importClosedAccounts')}
            hint={t('mnyReview.options.importClosedAccountsHint')}
            checked={options.importClosedAccounts ?? true}
            onChange={(value) => onSetOption('importClosedAccounts', value)}
          />
          <OptionCheckbox
            label={t('mnyReview.options.importPrices')}
            hint={t('mnyReview.options.importPricesHint')}
            checked={options.importPrices ?? true}
            onChange={(value) => onSetOption('importPrices', value)}
          />
          <OptionCheckbox
            label={t('mnyReview.options.importExchangeRates')}
            hint={t('mnyReview.options.importExchangeRatesHint')}
            checked={options.importExchangeRates ?? true}
            onChange={(value) => onSetOption('importExchangeRates', value)}
          />
        </div>

        {/*
          The wipe is separated and styled as the destructive option it is: it
          runs the same delete-my-data operation as Settings, and ticking it
          only arms a typed confirmation -- nothing is deleted until then.
        */}
        <div className="mt-4 pt-4 border-t border-border">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={options.wipeExistingData ?? false}
              onChange={(e) => onSetOption('wipeExistingData', e.target.checked)}
              className="mt-0.5 rounded border-border"
            />
            <span>
              <span className="text-sm font-medium text-red-600 dark:text-red-400">
                {t('mnyReview.options.wipeExistingData')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t('mnyReview.options.wipeExistingDataHint')}
              </span>
            </span>
          </label>
        </div>
      </div>

      {/*
        Mapper warnings, each expandable to the transactions behind it. This is
        the last point at which the answer to "why is that split wrong" is to
        go and fix it in Money, so the list has to name the transactions rather
        than only count them.
      */}
      <MnyWarningsPanel
        warnings={preview.warnings}
        heading={t('mnyReview.warningsHeading')}
      />

      {/*
        A start that never began. Without this the button simply does nothing --
        the staged file expired under an abandoned wizard, or another import is
        already running, and the user has no way to tell which.
      */}
      {startError && (
        <div
          role="alert"
          className="mt-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
        >
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">
            {t('mnyReview.startFailedHeading')}
          </h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            {startError.message || t('mnyErrors.mnyImportFailed')}
          </p>
          <p className="mt-2 text-sm">
            <HelpLink
              link={mnyErrorDocsLink(startError.code)}
              className="font-medium text-red-800 underline hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
            >
              {t('mnyImporting.learnMore')}
            </HelpLink>
          </p>
          {startError.code === 'mnyStagedFileMissing' && (
            <Button
              variant="outline"
              className="mt-3"
              onClick={onBack}
              disabled={isLoading}
            >
              {t('mnyReview.uploadAgain')}
            </Button>
          )}
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          {t('navigation.back')}
        </Button>
        <Button
          onClick={onImport}
          isLoading={isLoading}
          disabled={includedCount === 0}
        >
          {t('mnyReview.startImport')}
        </Button>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function OptionCheckbox({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-border"
      />
      <span>
        <span className="text-sm text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
