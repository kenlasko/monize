'use client';

import { useRouter } from 'next/navigation';
import { showErrorToast } from '@/lib/errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { TransactionList } from '@/components/transactions/TransactionList';
import { useFormModal } from '@/hooks/useFormModal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { transactionsApi } from '@/lib/transactions';
import { createLogger } from '@/lib/logger';
import { PAGE_SIZE } from '@/lib/constants';
import type { PaginationInfo, Transaction } from '@/types/transaction';

const logger = createLogger('PayeeTransactionsTab');

const TransactionForm = dynamic(
  () =>
    import('@/components/transactions/TransactionForm').then(
      (m) => m.TransactionForm,
    ),
  { ssr: false },
);

interface PayeeTransactionsTabProps {
  basis?: 'cash' | 'accrual';
  payeeId: string;
  /** Bumped by the page on every reload so the list refetches in lockstep. */
  refreshKey?: number;
  /** Hierarchical category labels and colours, as the register passes them. */
  categoryLabelMap: Map<string, string>;
  categoryColorMap: Map<string, string | null>;
  categoryIconMap: Map<string, string | null>;
  /** Called after an edit or delete, so the page's cards recompute. */
  onChanged: () => void;
  /** Open the full register, filtered to this payee. */
  onViewInRegister: () => void;
  /** Narrow the register to one day (a row's date link). */
  onSelectDate: (date: string) => void;
}

/**
 * Every transaction for this payee, paginated, in the app's own register list.
 *
 * Uses `TransactionList` rather than a table of its own, which is what makes the
 * rows editable in place: the shared list already carries the row actions, the
 * status cycling, the split and transfer affordances, the density control and the
 * hierarchical category labels. A second read-only table here would have to grow
 * all of that again, and would drift from the register the first time one of them
 * changed.
 *
 * Editing opens the same `TransactionForm` the register opens, on this page, so
 * a correction never costs the reader their place.
 */
export function PayeeTransactionsTab({
  basis = 'cash',
  payeeId,
  refreshKey,
  categoryLabelMap,
  categoryColorMap,
  categoryIconMap,
  onChanged,
  onViewInRegister,
  onSelectDate,
}: PayeeTransactionsTabProps) {
  const t = useTranslations('payeeDetail');
  const tt = useTranslations('transactions');
  const router = useRouter();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const {
    showForm,
    editingItem,
    openEdit,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Transaction>();

  const requestKey = `${basis}:${payeeId}:${page}:${refreshKey ?? 0}`;
  const isLoading = loadedKey !== requestKey;

  // Bumped locally so an edit or delete refetches the page currently on screen
  // without disturbing the payee or page number.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The guard keeps a stale response -- from a previous page, or a previous
    // payee if the switcher moved on -- from landing in the list.
    const key = requestKey;
    transactionsApi
      .getAll({ basis, payeeId, page, limit: PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setTransactions(result.data);
        setPagination(result.pagination);
        setError(false);
        setLoadedKey(key);
      })
      .catch((err) => {
        logger.error(err);
        if (cancelled) return;
        setTransactions([]);
        setPagination(null);
        setError(true);
        setLoadedKey(key);
      });
    return () => {
      cancelled = true;
    };
  }, [basis, payeeId, page, requestKey, reloadTick]);

  // A row edited or deleted in place: refetch this list and let the page
  // recompute its cards, which the change may well have moved.
  const handleChanged = useCallback(() => {
    setReloadTick((tick) => tick + 1);
    onChanged();
  }, [onChanged]);

  // Deleting is the list's own job -- it confirms, handles the transfer case,
  // toasts, and then calls `onRefresh`. Doing it here as well would delete twice.

  // A status cycled in the row: patch that row rather than refetch the page, so
  // the list does not jump, but still let the page's totals catch up.
  const handleTransactionUpdate = useCallback(
    (updated: Transaction) => {
      setTransactions((current) =>
        current.map((row) => (row.id === updated.id ? updated : row)),
      );
      onChanged();
    },
    [onChanged],
  );

  const totalPages = pagination?.totalPages ?? 1;

  const heading = useMemo(
    () =>
      pagination
        ? t('transactionsTab.titleWithCount', { count: pagination.total })
        : t('transactionsTab.title'),
    [pagination, t],
  );

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {heading}
        </h2>
        <button
          type="button"
          onClick={onViewInRegister}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('transactionsTab.openInRegister')}
        </button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('transactionsTab.loadFailed')}
        </p>
      ) : transactions.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('transactionsTab.empty')}
        </p>
      ) : (
        <TransactionList
          densityView="payeeDetail"
          transactions={transactions}
          readOnly={basis === 'accrual'}
          onEdit={async (row) => {
            if (!row.reportingProvenance) { openEdit(row); return; }
            try {
              const source = await transactionsApi.getById(row.reportingProvenance.sourceTransactionId);
              if (row.linkedInvestmentTransactionId) router.push(`/investments?edit=${row.linkedInvestmentTransactionId}`);
              else openEdit({...source, accrualRecognitionDate: row.reportingProvenance?.isRecognition ? row.transactionDate : undefined});
            } catch (error) { showErrorToast(error, tt('toasts.loadFailed')); }
          }}
          onRefresh={handleChanged}
          onTransactionUpdate={handleTransactionUpdate}
          onDateFilterClick={onSelectDate}
          currentPage={page}
          totalPages={totalPages}
          totalItems={pagination?.total ?? 0}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          categoryLabelMap={categoryLabelMap}
          categoryColorMap={categoryColorMap}
          categoryIconMap={categoryIconMap}
        />
      )}

      {/* The register's own edit window, opened here so a correction does not
          cost the reader their place on the page. */}
      <Modal
        isOpen={showForm}
        onClose={close}
        {...modalProps}
        maxWidth="2xl"
        className="p-6"
      >
        <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
          {tt('page.editModal.editTitle')}
        </h2>
        {showForm && editingItem && (
          <TransactionForm
            onAccrualChanged={handleChanged}
            transaction={editingItem}
            onSuccess={() => {
              close();
              handleChanged();
            }}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        )}
      </Modal>
      <UnsavedChangesDialog {...unsavedChangesDialog} />
    </div>
  );
}
