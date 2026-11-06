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
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList } from '@/components/transactions/TransactionList';
import { ForeignCurrencyFeeChart } from '@/components/accounts/shared/ForeignCurrencyFeeChart';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import type { Account } from '@/types/account';
import type {
  FxFeeMonthlyTotal,
  MonthlyTotal,
  PaginationInfo,
  Transaction,
} from '@/types/transaction';
import { EmptyState } from '@/components/ui/EmptyState';
import { fromMoneyUnits, moneyDecimalsForCurrency, toMoneyUnits } from '@/lib/format';
import { useCurrencyDecimalsVersion } from '@/hooks/useCurrencyDecimalsVersion';

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
  const { defaultCurrency, convertToDefault } = useExchangeRates();

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

  const convertFee = useCallback(
    (amount: number, accountCurrency: string): number | null => {
      if (accountCurrency === displayCurrency) return amount;
      return convertToDefault(amount, accountCurrency || defaultCurrency);
    },
    [displayCurrency, convertToDefault, defaultCurrency],
  );

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

  // Roll every account's rows up to one converted fee total per month, honouring
  // the currency filter. Accumulated in integer units of the display
  // currency's money precision (four for fiat, a coin's eight when every
  // account in scope is that coin) to avoid drift.
  const registryVersion = useCurrencyDecimalsVersion();
  const monthlyFees = useMemo(() => {
    const active = selectedCurrencies.length > 0 ? new Set(selectedCurrencies) : null;
    const decimals = moneyDecimalsForCurrency(displayCurrency);
    const byMonth = new Map<string, { units: bigint; count: number }>();
    // A fee whose currency has no rate to the display currency is left out of
    // the chart (added at its face value it would be a figure in another
    // currency), so its currency is named and it is counted -- the chart is a
    // subtotal, not the whole, and the note beside it says so.
    const missing = new Set<string>();
    let excludedCount = 0;
    for (const result of feeResults) {
      for (const row of result.rows) {
        if (active && !active.has(row.currencyCode)) continue;
        const converted = convertFee(row.feeTotal, result.currency);
        if (converted === null) {
          missing.add(result.currency);
          excludedCount += row.count;
          continue;
        }
        const bucket = byMonth.get(row.month) ?? { units: BigInt(0), count: 0 };
        if (Number.isFinite(converted)) bucket.units += toMoneyUnits(converted, decimals);
        bucket.count += row.count;
        byMonth.set(row.month, bucket);
      }
    }
    const data: MonthlyTotal[] = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        total: fromMoneyUnits(bucket.units, decimals),
        count: bucket.count,
      }));
    return { data, missingCurrencies: [...missing], excludedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the registry version re-runs the read
  }, [feeResults, selectedCurrencies, convertFee, displayCurrency, registryVersion]);

  const currencyKey = selectedCurrencies.join(',');
  const availableKey = availableCurrencies.join(',');

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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <EmptyState title={tr('foreignCurrencyFees.noEligibleAccounts')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <ForeignCurrencyFeeChart
          data={monthlyFees.data}
          isLoading={isFeeLoading}
          currencyCode={displayCurrency}
        />
        {monthlyFees.missingCurrencies.length > 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {tCommon('partialTotal.explanation', {
              count: monthlyFees.excludedCount,
              displayCurrency,
              currencies: monthlyFees.missingCurrencies.join(', '),
            })}
          </p>
        )}
      </div>

      {/* Transactions */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
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

      <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('list.editTitle')}
        </h2>
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
