'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { transactionsApi } from '@/lib/transactions';
import { exportForeignTransactionsCsv } from '@/lib/fx-fees-csv';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { createLogger } from '@/lib/logger';
import { Modal } from '@/components/ui/Modal';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList } from '@/components/transactions/TransactionList';
import { ForeignCurrencyFeeChart } from './ForeignCurrencyFeeChart';
import { useFormModal } from '@/hooks/useFormModal';
import type { Account } from '@/types/account';
import type {
  FxFeeMonthlyTotal,
  MonthlyTotal,
  PaginationInfo,
  Transaction,
} from '@/types/transaction';

const logger = createLogger('ForeignCurrencyFeesSection');

const PAGE_SIZE = 25;

// Integer ten-thousandths, matching the backend's decimal(20,4) money scale.
const SCALE = 10000;

interface ForeignCurrencyFeesSectionProps {
  account: Account;
}

/**
 * Account-detail section for foreign-entered transactions. What it shows keys
 * off two things: whether a non-zero foreign-transaction fee is configured, and
 * whether the account actually has any foreign transactions.
 *
 *  - Fee configured and foreign transactions exist: the fee bar chart (fees
 *    incurred over the life of the account) plus the matching transaction
 *    register, under a "Foreign Currency Transaction Fees" heading.
 *  - No fee (or none entered) but foreign transactions exist: just the
 *    transaction register, under a "Foreign Currency Transactions" heading --
 *    there are no fees to chart.
 *  - No foreign transactions at all: nothing (the section renders null).
 *
 * The register carries edit/delete plus per-transaction currency, paid-amount,
 * and fee columns, and a paid-currency filter that drives the chart (when
 * shown) and the list.
 */
export function ForeignCurrencyFeesSection({ account }: ForeignCurrencyFeesSectionProps) {
  const t = useTranslations('accountDetail-fxFees');
  const router = useRouter();

  const [feeSummary, setFeeSummary] = useState<FxFeeMonthlyTotal[]>([]);
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [summaryLoadedForId, setSummaryLoadedForId] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const isSummaryLoading = summaryLoadedForId !== account.id;

  // Reset filter and pagination when navigating to a different account without
  // a remount ("info from previous render" pattern -- no setState in effects).
  const [prevAccountId, setPrevAccountId] = useState(account.id);
  if (prevAccountId !== account.id) {
    setPrevAccountId(account.id);
    setSelectedCurrencies([]);
    setPage(1);
  }

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

  // Monthly fee rows per paid currency; drives both the chart and the list of
  // filterable currencies.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await transactionsApi.getFxFeeSummary(account.id).catch((error) => {
        logger.error('Failed to load foreign-transaction fee summary:', error);
        return [] as FxFeeMonthlyTotal[];
      });
      if (cancelled) return;
      setFeeSummary(rows);
      setSummaryLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id, refreshTick]);

  // Every paid currency seen on the account (fee split or not), for the filter.
  const availableCurrencies = useMemo(
    () => [...new Set(feeSummary.map((row) => row.currencyCode))].sort(),
    [feeSummary],
  );

  const currencyOptions = useMemo<MultiSelectOption[]>(
    () => availableCurrencies.map((code) => ({ value: code, label: code })),
    [availableCurrencies],
  );

  // Roll the per-currency rows up to one fee total per month, honouring the
  // currency filter (empty selection = all currencies). Sums are accumulated
  // in integer ten-thousandths to avoid float drift.
  const monthlyFees = useMemo<MonthlyTotal[]>(() => {
    const active = selectedCurrencies.length > 0 ? new Set(selectedCurrencies) : null;
    const byMonth = new Map<string, { cents: number; count: number }>();
    for (const row of feeSummary) {
      if (active && !active.has(row.currencyCode)) continue;
      const bucket = byMonth.get(row.month) ?? { cents: 0, count: 0 };
      bucket.cents += Math.round(row.feeTotal * SCALE);
      bucket.count += row.count;
      byMonth.set(row.month, bucket);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        total: bucket.cents / SCALE,
        count: bucket.count,
      }));
  }, [feeSummary, selectedCurrencies]);

  // The register: foreign-entered transactions in the filtered currencies.
  // Waits for the summary so "no filter" can expand to every paid currency on
  // the account (the transactions endpoint has no "any foreign currency" mode).
  const selectedKey = selectedCurrencies.join(',');
  const availableKey = availableCurrencies.join(',');
  useEffect(() => {
    if (summaryLoadedForId !== account.id) return;
    let cancelled = false;
    (async () => {
      const codes = selectedCurrencies.length > 0 ? selectedCurrencies : availableCurrencies;
      if (codes.length === 0) {
        // Yield first: the ESLint set-state-in-effect rule bans sync setState.
        await Promise.resolve();
        if (cancelled) return;
        setTransactions([]);
        setPagination(null);
        setListLoaded(true);
        return;
      }
      const result = await transactionsApi
        .getAll({
          accountId: account.id,
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
      setListLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, summaryLoadedForId, selectedKey, availableKey, page, refreshTick]);

  const handleCurrencyFilterChange = useCallback((values: string[]) => {
    setSelectedCurrencies(values);
    setPage(1);
  }, []);

  // Mirrors the transactions page: investment-linked rows edit on the
  // investments page; transfers and splits reload in full so the form has
  // every split (the list payload already carries them, but stay consistent).
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

  // Export every foreign transaction matching the current currency filter (or
  // all paid currencies on the account when no filter is set) to CSV.
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const codes = selectedCurrencies.length > 0 ? selectedCurrencies : availableCurrencies;
      const count = await exportForeignTransactionsCsv({
        accountIds: [account.id],
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
  }, [account.id, selectedCurrencies, availableCurrencies, t]);

  // Whether a non-zero foreign-transaction fee is configured, and whether the
  // account has any foreign-entered transactions at all (a non-empty fee
  // summary -- the backend returns a row per foreign transaction, fee or not).
  const hasFee = Number(account.fxFeePercent) > 0;
  const hasForeignTransactions = availableCurrencies.length > 0;

  // Wait until the summary loads before deciding what (if anything) to render,
  // so accounts with no foreign transactions never flash an empty section. The
  // fee chart is reserved for accounts that both charge a fee and have foreign
  // transactions; every other account with foreign transactions still gets the
  // register on its own.
  if (isSummaryLoading || !hasForeignTransactions) {
    return null;
  }

  const showFees = hasFee;

  // When the chart is shown, the paid-currency filter rides in its header;
  // otherwise it moves to the transaction card so the list stays filterable.
  const currencyFilter = (
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
  );

  return (
    <section {...tourAnchor(TOUR_ANCHORS.foreignCurrencyFees)}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {showFees ? t('title') : t('list.title')}
      </h2>
      <div className="space-y-6">
        {showFees && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
            <ForeignCurrencyFeeChart
              data={monthlyFees}
              isLoading={isSummaryLoading}
              currencyCode={account.currencyCode}
              accountName={account.name}
              hideTitle
              leftControls={currencyFilter}
            />
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          {showFees ? (
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 px-4 pt-4 sm:px-6 sm:pt-6 pb-2">
              {t('list.title')}
            </h3>
          ) : (
            <div className="px-4 pt-4 sm:px-6 sm:pt-6 pb-2">{currencyFilter}</div>
          )}
          {listLoaded && (
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
          )}
        </div>
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
    </section>
  );
}
