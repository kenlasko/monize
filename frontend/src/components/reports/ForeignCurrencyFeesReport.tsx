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

const logger = createLogger('ForeignCurrencyFeesReport');

const PAGE_SIZE = 25;
// Integer ten-thousandths, matching the backend's decimal(20,4) money scale.
const SCALE = 10000;

const hasFxFee = (account: Account): boolean => Number(account.fxFeePercent) > 0;

interface FeeResult {
  /** Per-month fee rows for one account (feeTotal in that account's currency). */
  rows: FxFeeMonthlyTotal[];
  /** The account's own currency, used to convert its fees for display. */
  currency: string;
}

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
  const router = useRouter();
  const { defaultCurrency, convertToDefault } = useExchangeRates();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
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
    (amount: number, accountCurrency: string): number => {
      if (accountCurrency === displayCurrency) return amount;
      return convertToDefault(amount, accountCurrency || defaultCurrency);
    },
    [displayCurrency, convertToDefault, defaultCurrency],
  );

  const isFeeLoading = accountKey.length > 0 && feeLoadedKey !== accountKey;

  // Per-account monthly fee rows, tagged with each account's own currency.
  useEffect(() => {
    if (!accountsLoaded || effectiveAccountIds.length === 0) {
      setFeeResults([]);
      setFeeLoadedKey(accountKey);
      return;
    }
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
  // the currency filter. Accumulated in integer ten-thousandths to avoid drift.
  const monthlyFees = useMemo<MonthlyTotal[]>(() => {
    const active = selectedCurrencies.length > 0 ? new Set(selectedCurrencies) : null;
    const byMonth = new Map<string, { cents: number; count: number }>();
    for (const result of feeResults) {
      for (const row of result.rows) {
        if (active && !active.has(row.currencyCode)) continue;
        const converted = convertFee(row.feeTotal, result.currency);
        const bucket = byMonth.get(row.month) ?? { cents: 0, count: 0 };
        bucket.cents += Math.round(converted * SCALE);
        bucket.count += row.count;
        byMonth.set(row.month, bucket);
      }
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        total: bucket.cents / SCALE,
        count: bucket.count,
      }));
  }, [feeResults, selectedCurrencies, convertFee]);

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
  }, []);

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
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {tr('foreignCurrencyFees.noEligibleAccounts')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <ReportAccountMultiSelect
            accounts={accounts}
            value={selectedAccountIds}
            onChange={handleAccountChange}
            filter={hasFxFee}
          />
          <div className="w-52 max-w-full">
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
          data={monthlyFees}
          isLoading={isFeeLoading}
          currencyCode={displayCurrency}
        />
      </div>

      {/* Transactions */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 px-4 pt-4 sm:px-6 sm:pt-6 pb-2">
          {t('list.title')}
        </h3>
        <TransactionList
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
