'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { exportForeignTransactionsCsv } from '@/lib/fx-fees-csv';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useFormModal } from '@/hooks/useFormModal';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { createLogger } from '@/lib/logger';
import { Modal } from '@/components/ui/Modal';
import { transactionModalProps } from '@/components/transactions/transaction-modal';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList } from '@/components/transactions/TransactionList';
import { ForeignCurrencyFeeChart } from '@/components/accounts/shared/ForeignCurrencyFeeChart';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import type { Account } from '@/types/account';
import type {
  FxFeeMonthlyTotal,
  FxFeeTotals,
  MonthlyTotal,
  PaginationInfo,
  Transaction,
} from '@/types/transaction';
import { EmptyState } from '@/components/ui/EmptyState';
import { ReportError } from '@/components/reports/ReportError';
import { CARD_CLASS } from '@/components/ui/Card';

const logger = createLogger('ForeignCurrencyFeesReport');

const PAGE_SIZE = 25;

const hasFxFee = (account: Account): boolean => Number(account.fxFeePercent) > 0;

interface FeeResult {
  /** Per-month fee rows for one account (feeTotal in that account's currency). */
  rows: FxFeeMonthlyTotal[];
  /** The account's own currency, used to convert its fees for display. */
  currency: string;
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-foreign-currency-fees-accounts';

/**
 * Foreign Currency Transaction Fees report: the same chart and transaction
 * table as the account-detail section, but across one or more accounts. The
 * account picker only offers accounts with a non-zero foreign-transaction fee.
 * Because each account reports its fees in its own currency, a mixed-currency
 * selection is converted to the user's default currency for the chart; a
 * single-currency selection stays native.
 */
export function ForeignCurrencyFeesReport() {
  const t = useTranslations('accountDetail-fxFees');
  const tr = useTranslations('reports');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { defaultCurrency } = useExchangeRates();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);
  const [feeResults, setFeeResults] = useState<FeeResult[]>([]);
  const [feeLoadedKey, setFeeLoadedKey] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const {
    showForm,
    editingItem: editingTransaction,
    openEdit,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Transaction>();

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  // Load accounts once on mount.
  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getAll()
      .then((rows) => {
        if (!cancelled) {
          setAccounts(rows);
          setAccountsLoaded(true);
        }
      })
      .catch((error) => {
        logger.error('Failed to load accounts:', error);
        if (!cancelled) setAccountsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const eligibleAccounts = useMemo(() => accounts.filter(hasFxFee), [accounts]);

  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    eligibleAccounts,
  );

  // No selection means "all eligible accounts".
  const effectiveAccountIds = useMemo(
    () =>
      selectedAccountIds.length > 0
        ? selectedAccountIds
        : eligibleAccounts.map((a) => a.id),
    [selectedAccountIds, eligibleAccounts],
  );
  const accountKey = useMemo(
    () => [...effectiveAccountIds].sort().join(','),
    [effectiveAccountIds],
  );

  const accountsById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  // Currencies of the accounts in scope; a single shared currency renders
  // natively, otherwise everything converts to the default currency.
  const displayCurrency = useMemo(() => {
    const currencies = new Set(
      effectiveAccountIds
        .map((id) => accountsById.get(id)?.currencyCode)
        .filter((c): c is string => !!c),
    );
    return currencies.size === 1 ? [...currencies][0] : defaultCurrency;
  }, [effectiveAccountIds, accountsById, defaultCurrency]);

  // Nothing to fetch (no account in scope, or the account list has not
  // arrived): the fee rows are empty and settled for this key. Adjusted during
  // render rather than from the loading effect below.
  const feeRequestEmpty = !accountsLoaded || effectiveAccountIds.length === 0;
  if (feeRequestEmpty && (feeLoadedKey !== accountKey || feeResults.length > 0)) {
    setFeeResults([]);
    setFeeLoadedKey(accountKey);
  }

  const isFeeLoading = accountKey.length > 0 && feeLoadedKey !== accountKey;

  // Per-account monthly fee rows, tagged with each account's own currency.
  useEffect(() => {
    if (!accountsLoaded || effectiveAccountIds.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        effectiveAccountIds.map(async (id) => {
          const rows = await transactionsApi
            .getFxFeeSummary(id)
            .catch((error) => {
              logger.error('Failed to load fee summary:', error);
              return [] as FxFeeMonthlyTotal[];
            });
          return {
            rows,
            currency: accountsById.get(id)?.currencyCode ?? defaultCurrency,
          };
        }),
      );
      if (cancelled) return;
      setFeeResults(results);
      setFeeLoadedKey(accountKey);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, accountsLoaded, refreshTick]);

  const availableCurrencies = useMemo(
    () =>
      [
        ...new Set(feeResults.flatMap((r) => r.rows.map((row) => row.currencyCode))),
      ].sort(),
    [feeResults],
  );

  const currencyOptions = useMemo<MultiSelectOption[]>(
    () => availableCurrencies.map((code) => ({ value: code, label: code })),
    [availableCurrencies],
  );

  const currencyKey = selectedCurrencies.join(',');
  const availableKey = availableCurrencies.join(',');

  // The chart's figures are the server's, over the accounts and paid
  // currencies chosen: each column, the total and each average read once from
  // the fees' aggregates. Summed here from each account's four-place
  // conversions, three fees of 2.50496 read 7.50 where they come to 7.51
  // (issue #2413). Kept with the selection that asked for them.
  const totalsKey = `${accountKey}|${currencyKey}|${refreshTick}`;
  const [feeTotals, setFeeTotals] = useState<{ key: string; totals: FxFeeTotals | null } | null>(null);
  useEffect(() => {
    if (!accountsLoaded || effectiveAccountIds.length === 0) return;
    let cancelled = false;
    transactionsApi
      .getFxFeeTotals(effectiveAccountIds, selectedCurrencies)
      .catch((error) => {
        logger.error('Failed to load fee totals:', error);
        return null;
      })
      .then((totals) => {
        if (!cancelled) setFeeTotals({ key: totalsKey, totals });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalsKey, accountsLoaded]);
  const totals = feeTotals?.key === totalsKey && !feeRequestEmpty ? feeTotals.totals : null;
  const isTotalsLoading = !feeRequestEmpty && feeTotals?.key !== totalsKey;
  // A request that failed is said to be one, never drawn as no fees.
  const totalsFailed = !feeRequestEmpty && feeTotals?.key === totalsKey && feeTotals.totals === null;
  const chartMonths = useMemo<MonthlyTotal[]>(
    () =>
      (totals?.byGranularity.month.buckets ?? []).map((bucket) => ({
        month: bucket.key,
        total: bucket.total,
        knownSubtotal: bucket.knownTotal,
        count: bucket.count,
      })),
    [totals],
  );


  // The register: foreign transactions across the selected accounts and paid
  // currencies (defaulting to all paid currencies on those accounts).
  useEffect(() => {
    if (feeLoadedKey !== accountKey) return;
    let cancelled = false;
    (async () => {
      const codes = selectedCurrencies.length > 0 ? selectedCurrencies : availableCurrencies;
      if (effectiveAccountIds.length === 0 || codes.length === 0) {
        await Promise.resolve();
        if (cancelled) return;
        setTransactions([]);
        setPagination(null);
        return;
      }
      const result = await transactionsApi
        .getAll({
          accountIds: effectiveAccountIds,
          originalCurrencyCodes: codes,
          page,
          limit: PAGE_SIZE,
        })
        .catch((error) => {
          logger.error('Failed to load foreign-currency transactions:', error);
          return null;
        });
      if (cancelled || !result) return;
      setTransactions(result.data);
      setPagination(result.pagination);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, feeLoadedKey, currencyKey, availableKey, page, refreshTick]);

  const handleAccountChange = useCallback((values: string[]) => {
    setSelectedAccountIds(values);
    setSelectedCurrencies([]);
    setPage(1);
  }, [setSelectedAccountIds]);

  const handleCurrencyFilterChange = useCallback((values: string[]) => {
    setSelectedCurrencies(values);
    setPage(1);
  }, []);

  const handleEdit = useCallback(
    async (transaction: Transaction) => {
      if (transaction.linkedInvestmentTransactionId) {
        toast(t('list.investmentLinked'));
        router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
        return;
      }
      if (transaction.isTransfer || transaction.isSplit) {
        try {
          openEdit(await transactionsApi.getById(transaction.id));
        } catch (error) {
          logger.error('Failed to load transaction details:', error);
          openEdit(transaction);
        }
      } else {
        openEdit(transaction);
      }
    },
    [openEdit, router, t],
  );

  const handleFormSuccess = useCallback(() => {
    close();
    refresh();
  }, [close, refresh]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const codes = selectedCurrencies.length > 0 ? selectedCurrencies : availableCurrencies;
      const count = await exportForeignTransactionsCsv({
        accountIds: effectiveAccountIds,
        currencyCodes: codes,
      });
      if (count === 0) {
        toast.error(t('list.export.none'));
      } else {
        toast.success(t('list.export.success', { count }));
      }
    } catch (error) {
      logger.error('Failed to export foreign-currency transactions:', error);
      toast.error(t('list.export.failed'));
    } finally {
      setIsExporting(false);
    }
  }, [effectiveAccountIds, selectedCurrencies, availableCurrencies, t]);

  if (accountsLoaded && eligibleAccounts.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <EmptyState title={tr('foreignCurrencyFees.noEligibleAccounts')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className={`${CARD_CLASS} p-4`}>
        <div className="flex flex-wrap gap-3 items-center">
          {/* Both pickers take the card's width on a phone -- side by side
              they are wider than the screen -- and their toolbar widths from
              `sm` up. */}
          <ReportAccountMultiSelect
            accounts={accounts}
            value={selectedAccountIds}
            onChange={handleAccountChange}
            filter={hasFxFee}
            className="w-full sm:w-48"
          />
          <div className="w-full max-w-full sm:w-52">
            <MultiSelect
              ariaLabel={t('currencyFilter.label')}
              options={currencyOptions}
              value={selectedCurrencies}
              onChange={handleCurrencyFilterChange}
              placeholder={t('currencyFilter.placeholder')}
              disabled={currencyOptions.length === 0}
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        {totalsFailed ? (
          <ReportError onRetry={refresh} />
        ) : (
        <ForeignCurrencyFeeChart
          data={chartMonths}
          isLoading={isFeeLoading || isTotalsLoading}
          currencyCode={totals?.currency ?? displayCurrency}
          totals={totals ?? undefined}
        />
        )}
        {totals && totals.missingCurrencies.length > 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {tCommon('partialTotal.explanation', {
              count: totals.excludedCount,
              displayCurrency: totals.currency,
              currencies: totals.missingCurrencies.join(', '),
            })}
          </p>
        )}
      </div>

      {/* Transactions */}
      <div className={`${CARD_CLASS} overflow-hidden`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 px-4 pt-4 sm:px-6 sm:pt-6 pb-2">
          {t('list.title')}
        </h3>
        <TransactionList
          densityView="fxFeesReport"
          transactions={transactions}
          onEdit={handleEdit}
          onRefresh={refresh}
          onExport={handleExport}
          isExporting={isExporting}
          showFxColumns
          currentPage={pagination?.page}
          totalPages={pagination?.totalPages}
          totalItems={pagination?.total}
          pageSize={pagination?.limit}
          onPageChange={setPage}
        />
      </div>

      <Modal isOpen={showForm} onClose={close} {...modalProps} {...transactionModalProps} title={t('list.editTitle')}>
        <TransactionForm
          key={editingTransaction?.id || 'none'}
          transaction={editingTransaction}
          onSuccess={handleFormSuccess}
          onCancel={close}
          onDirtyChange={setFormDirty}
          submitRef={formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...unsavedChangesDialog} />
    </div>
  );
}
