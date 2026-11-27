'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { formatAccountType } from '@/lib/account-utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { MnyAccountVerification, MnyImportResult } from '@/lib/import-mny';
import { AccountType } from '@/types/account';
import { MnyWarningsPanel } from './MnyWarningsPanel';
import { Th } from '@/components/ui/Table';
import { BinaryImportFormat, MNY_FORMAT } from '@/lib/binary-import-format';

/** Account types whose verification line is badged, per the comment below. */
const LOAN_TYPES: ReadonlySet<string> = new Set(['LOAN', 'MORTGAGE']);

interface MnyVerificationReportProps {
  result: MnyImportResult;
  /** Base currency of the file, used to format the report's money columns. */
  currencyCode: string;
  filename: string;
  onDone: () => void;
  /** Which file format was imported; Money when omitted. */
  format?: BinaryImportFormat;
}

/**
 * What was imported, and whether it reconciles.
 *
 * The banner is the point of this screen. Both PR #192 testers said the same
 * thing: a 56-account, 30-year migration is impossible to trust without being
 * told, per account, that the balance Monize now holds equals the balance
 * computed from the Money file. "All 56 accounts match" is the answer; the table
 * is there for the cases where it is not.
 *
 * The JSON download exists for the same reason -- a user chasing a discrepancy
 * needs the numbers, not a screenshot.
 */
export function MnyVerificationReport({
  result,
  currencyCode,
  filename,
  onDone,
  format = MNY_FORMAT,
}: MnyVerificationReportProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  // Share counts go through the app's own quantity formatter, so the report
  // reads in the user's number locale like every other holdings view.
  const { formatQuantity, formatCurrency, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();

  // A KMyMoney account carries its own currency; Money's report is in the file's base currency.
  const lineCurrency = (line: MnyAccountVerification) =>
    line.currencyCode ?? currencyCode;

  const mismatches = result.verification.filter((line) => !line.matches);
  const holdingMismatches = result.holdings.filter((line) => !line.matches);
  const allMatch =
    mismatches.length === 0 &&
    holdingMismatches.length === 0 &&
    result.verification.length > 0;

  const downloadReport = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename.replace(format.reportExtension, '')}-import-report.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div
        className={`rounded-lg border p-4 mb-6 ${
          allMatch
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
        }`}
      >
        <h2
          className={`text-lg font-semibold ${
            allMatch
              ? 'text-green-800 dark:text-green-300'
              : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {t('mnyComplete.heading')}
        </h2>
        <p
          className={`mt-1 text-sm ${
            allMatch
              ? 'text-green-700 dark:text-green-300'
              : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {allMatch
            ? t(format.copy.allMatch, { count: result.verification.length })
            : mismatches.length > 0
              ? t(format.copy.someDiffer, { count: mismatches.length })
              : t(format.copy.someHoldingsDiffer, {
                  count: holdingMismatches.length,
                })}
        </p>
      </div>

      {/* What was created */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile
          label={t('mnyComplete.counts.accounts')}
          value={result.accountsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.transactions')}
          value={result.transactionsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.transfers')}
          value={result.transfersLinked}
        />
        <Tile
          label={t('mnyComplete.counts.splits')}
          value={result.splitsCreated}
        />
        <Tile
          label={t('mnyComplete.counts.payees')}
          value={result.payeesCreated}
        />
        <Tile
          label={t('mnyComplete.counts.categories')}
          value={result.categoriesCreated}
        />
        {result.tagLinksApplied > 0 && (
          <Tile
            label={t('mnyComplete.counts.taggedRows')}
            value={result.tagLinksApplied}
          />
        )}
        {result.securitiesCreated > 0 && (
          <Tile
            label={t('mnyComplete.counts.securities')}
            value={result.securitiesCreated}
          />
        )}
        {result.investmentTransactionsCreated > 0 && (
          <Tile
            label={t('mnyComplete.counts.investments')}
            value={result.investmentTransactionsCreated}
          />
        )}
        {format.copy.completePayeeAliases &&
          (result.payeeAliasesCreated ?? 0) > 0 && (
            <Tile
              label={t(format.copy.completePayeeAliases)}
              value={formatNumber(result.payeeAliasesCreated ?? 0, 0)}
            />
          )}
        {format.copy.completePayeeDefaultCategories &&
          (result.payeeDefaultCategoriesSet ?? 0) > 0 && (
            <Tile
              label={t(format.copy.completePayeeDefaultCategories)}
              value={formatNumber(result.payeeDefaultCategoriesSet ?? 0, 0)}
            />
          )}
        {result.billsCreated > 0 && (
          <Tile
            label={t('mnyComplete.counts.bills')}
            value={result.billsCreated}
          />
        )}
        {result.pricesImported > 0 && (
          <Tile
            label={t('mnyComplete.counts.prices')}
            value={result.pricesImported}
          />
        )}
        {result.exchangeRatesImported > 0 && (
          <Tile
            label={t('mnyComplete.counts.exchangeRates')}
            value={result.exchangeRatesImported}
          />
        )}
      </div>

      {result.existingDataRemoved && (
        <p className="mb-6 text-sm text-muted-foreground">
          {t('mnyComplete.existingDataRemoved')}
        </p>
      )}

      {(result.categoriesNotFitting ?? 0) > 0 && (
        <p className="mb-6 text-sm text-amber-800 dark:text-amber-300">
          {t('complete.categoriesNotFitting', { count: result.categoriesNotFitting ?? 0 })}
        </p>
      )}

      {(result.bondRowsWithoutSeries ?? 0) > 0 && (
        <p className="mb-6 text-sm text-amber-800 dark:text-amber-300">
          {t('mnyComplete.bondRowsWithoutSeries', { count: result.bondRowsWithoutSeries ?? 0 })}
        </p>
      )}

      {/* Per-account reconciliation */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t('mnyComplete.verificationHeading')}
        </h3>
        {format.copy.completeAsOf && result.fileAsOf && (
          <p className="text-xs text-muted-foreground mb-2">
            {t(format.copy.completeAsOf, { date: formatDate(result.fileAsOf) })}
          </p>
        )}
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th className="px-3 py-2">
                  {t('mnyComplete.table.account')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyComplete.table.transactions')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t(format.copy.tableExpected)}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyComplete.table.imported')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('mnyComplete.table.delta')}
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.verification.map((line) => (
                <tr key={line.accountName}>
                  <td className="px-3 py-2">
                    <span className="text-foreground">{line.accountName}</span>
                    {/*
                      Loans and mortgages are badged because they are where
                      PR #192's phantom-row filter silently emptied accounts:
                      a user scanning this table should be able to find them
                      without knowing which of their names are loans.
                    */}
                    {LOAN_TYPES.has(line.accountType) && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 rounded">
                        {formatAccountType(line.accountType as AccountType, tc)}
                      </span>
                    )}
                    {!line.matches && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded">
                        {t('mnyComplete.table.check')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {line.transactionCount}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(line.expectedBalance, lineCurrency(line))}
                    {/* KMyMoney only: what the import's own rows sum to, shown where the backend found it differs from the file's figure. */}
                    {line.mappedDiffers === true &&
                      line.mappedBalance !== undefined && (
                        <span className="block text-xs text-amber-700 dark:text-amber-400">
                          {t('kmyComplete.table.mappedDiffers', {
                            amount: formatCurrency(
                              line.mappedBalance,
                              lineCurrency(line),
                            ),
                          })}
                        </span>
                      )}
                  </td>
                  <td className="px-3 py-2 text-right text-foreground">
                    {formatCurrency(line.importedBalance, lineCurrency(line))}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-medium ${
                      line.matches
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {formatCurrency(line.delta, lineCurrency(line))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        Per-holding reconciliation. Money's open tax lots are the authority --
        they are the record Money itself reconciles against -- so the delta is
        measured from them, and the replay column shows whether a disagreement
        came from reading the file or from writing it.
      */}
      {result.holdings.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            {t('mnyComplete.holdingsHeading')}
          </h3>
          <p className="text-xs text-muted-foreground mb-2">
            {t(format.copy.holdingsExplainer)}
          </p>
          <div className="bg-card border border-border rounded-lg overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <Th className="px-3 py-2">
                    {t('mnyComplete.table.account')}
                  </Th>
                  <Th className="px-3 py-2">
                    {t('mnyComplete.table.security')}
                  </Th>
                  <Th align="right" className="px-3 py-2">
                    {t(format.copy.tableLotShares)}
                  </Th>
                  <Th align="right" className="px-3 py-2">
                    {t('mnyComplete.table.importedShares')}
                  </Th>
                  <Th align="right" className="px-3 py-2">
                    {t('mnyComplete.table.delta')}
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.holdings.map((line) => (
                  <tr key={`${line.accountName}|${line.symbol}`}>
                    <td className="px-3 py-2 text-foreground">
                      {line.accountName}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {line.symbol}
                      {!line.matches && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded">
                          {t('mnyComplete.table.check')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatQuantity(line.lotQuantity)}
                    </td>
                    <td className="px-3 py-2 text-right text-foreground">
                      {formatQuantity(line.importedQuantity)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        line.matches
                          ? 'text-green-700 dark:text-green-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {formatQuantity(line.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Warnings, expandable to the transactions behind each one */}
      <MnyWarningsPanel
        warnings={result.warnings}
        heading={t('mnyComplete.warningsHeading')}
        format={format}
      />

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={downloadReport}>
          {t('mnyComplete.downloadReport')}
        </Button>
        <Button onClick={onDone}>{t('mnyComplete.done')}</Button>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}
