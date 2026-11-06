'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { registerDateColumnPadding } from '@/components/transactions/register-date-columns';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLongPress } from '@/hooks/useLongPress';
import type { SortDirection } from '@/hooks/useSortableTable';
import { classifyStaleRow, type StaleUnreconciledReason } from '@/lib/stale-reconciliation';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { useCompactMobileDates } from '@/store/dateDisplayStore';
import { Th } from '@/components/ui/Table';
import {
  groupReconcileRows,
  sortReconcileRows,
  type ReconcileSortField,
} from './reconcile-rows';

interface ReconcileTableProps {
  transactions: Transaction[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  sortField: ReconcileSortField;
  sortDirection: SortDirection;
  onSort: (field: ReconcileSortField) => void;
  groupByFlow: boolean;
  /** Account's last reconciled date; null when it has never been reconciled. */
  lastReconciledDate: string | null;
  /** Server-chosen date a row must precede to count as overdue. */
  overdueBefore: string;
  formatCurrency: (amount: number) => string;
  /**
   * The account currency's money precision the subtotals are summed at
   * (`moneyDecimalsForCurrency`): four for fiat, a coin's eight.
   */
  moneyDecimals: number;
  onEdit: (transaction: Transaction) => void;
  onDelete: (transaction: Transaction) => void;
  onCycleStatus: (transaction: Transaction) => void;
  /** True while the strict reconciled lock is on, which disables the row actions. */
  reconciledLocked: boolean;
}

const STALE_ROW_CLASS =
  'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30';

/**
 * The reconcile step's transaction table.
 *
 * Every column sorts, the rows optionally group by which side of the ledger
 * they are on, and each row carries the same edit/delete actions the register
 * does -- reconciling is where a missing or wrong transaction is discovered, so
 * making the user leave the screen to fix one is the thing this replaces. The
 * actions column is drawn from `sm` up; on any width a long-press or a
 * right-click on the row (`useLongPress`) opens the same actions in the shared
 * `RowActionSheet` -- the only path on phones, where the column collapses. A
 * plain click keeps toggling the row's selection.
 *
 * Rows the account should already have reconciled are highlighted through the
 * shared `classifyStaleRow`, against the dates the server supplied, so the
 * highlight here and the count in the header badge always mean the same thing.
 *
 * Below `sm` the table must FIT the phone, not merely scroll: mobile Chrome
 * sizes the viewport that `position: fixed` elements attach to from the page's
 * widest content, and `overflow-x-auto` does not stop a wide table counting --
 * so an overflowing table here made every modal on the page (the edit form)
 * render hundreds of pixels past the screen. Category and Status therefore
 * collapse on phones, and the Date header carries the register's shared
 * year-hiding toggle (`useCompactMobileDates`), the same trades the register
 * makes (`TransactionRow`), rather than relying on horizontal scroll.
 */
export function ReconcileTable({
  transactions,
  selectedIds,
  onToggle,
  sortField,
  sortDirection,
  onSort,
  groupByFlow,
  lastReconciledDate,
  overdueBefore,
  formatCurrency,
  moneyDecimals,
  onEdit,
  onDelete,
  onCycleStatus,
  reconciledLocked,
}: ReconcileTableProps) {
  const t = useTranslations('reconcile');
  const tc = useTranslations('common');
  // The date-shortening toggle is the register's; its copy lives there too.
  const tt = useTranslations('transactions');
  const { formatDate, formatDateWithoutYear } = useDateFormat();
  const { compactMobileDates, toggleCompactMobileDates } = useCompactMobileDates();
  const compactPadding = registerDateColumnPadding(compactMobileDates);
  // Blank-payee transfer legs resolve "Transfer to/from <account>" at render
  // time (issue #1214); the sort below is handed the same resolver so the
  // Payee column orders by exactly the text it shows.
  const payeeDisplay = usePayeeDisplay();

  const [sheetTransaction, setSheetTransaction] = useState<Transaction | null>(null);

  const { getRowHandlers } = useLongPress<Transaction>({
    onLongPress: setSheetTransaction,
    onClick: (transaction) => onToggle(transaction.id),
  });

  const groups = useMemo(
    () =>
      groupReconcileRows(
        sortReconcileRows(transactions, sortField, sortDirection, payeeDisplay),
        groupByFlow,
        moneyDecimals,
      ),
    [transactions, sortField, sortDirection, groupByFlow, payeeDisplay, moneyDecimals],
  );

  const staleByRow = useMemo(() => {
    const map = new Map<string, StaleUnreconciledReason>();
    for (const transaction of transactions) {
      const reason = classifyStaleRow(
        transaction.status,
        transaction.transactionDate,
        lastReconciledDate,
        overdueBefore,
      );
      if (reason) map.set(transaction.id, reason);
    }
    return map;
  }, [transactions, lastReconciledDate, overdueBefore]);

  const buildActions = (transaction: Transaction): RowAction[] => [
    {
      key: 'edit',
      label: tc('actions.edit'),
      icon: 'edit',
      tone: 'primary',
      onClick: () => onEdit(transaction),
    },
    {
      key: 'delete',
      label: tc('actions.delete'),
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => onDelete(transaction),
    },
  ];

  // The strict reconciled lock used to withhold the actions column's buttons on
  // RECONCILED rows. The sheet keeps the same promise by disabling them, with
  // the lock named in the subtitle so the greyed rows read as a state, not a
  // fault.
  const sheetLocked =
    sheetTransaction !== null &&
    sheetTransaction.status === TransactionStatus.RECONCILED &&
    reconciledLocked;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr>
            <Th className="px-2 sm:px-4 w-10">
              <span className="sr-only">{t('list.colSelect')}</span>
            </Th>
            <SortableHeader
              field="date"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className={`px-2 sm:px-4 ${compactPadding.date} py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase`}
            >
              <span className="inline-flex items-center gap-1">
                {t('list.colDate')}
                {/* The register's year-hiding toggle, shared store and all.
                    Only drawn below `sm`, where the full date is what crowds
                    the payee; the click must not also sort the column. */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCompactMobileDates();
                  }}
                  aria-pressed={compactMobileDates}
                  aria-label={tt('list.dateDisplay.toggleLabel')}
                  title={tt('list.dateDisplay.toggleTitle')}
                  className={`sm:hidden rounded p-0.5 focus-visible:outline-2 focus-visible:outline-blue-500 ${
                    compactMobileDates
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2M9 12h6" />
                  </svg>
                </button>
              </span>
            </SortableHeader>
            <SortableHeader
              field="payee"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className={`px-2 sm:px-4 ${compactPadding.payee} py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase`}
            >
              {t('list.colPayee')}
            </SortableHeader>
            <SortableHeader
              field="category"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className="hidden sm:table-cell px-2 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colCategory')}
            </SortableHeader>
            <SortableHeader
              field="amount"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              align="right"
              className="px-2 sm:px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colAmount')}
            </SortableHeader>
            <SortableHeader
              field="status"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              align="center"
              className="hidden sm:table-cell px-2 sm:px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colStatus')}
            </SortableHeader>
            <Th align="right" className="hidden sm:table-cell px-2 sm:px-4">
              <span className="sr-only">{t('list.colActions')}</span>
            </Th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody
            key={group.flow ?? 'all'}
            className="divide-y divide-gray-200 dark:divide-gray-700"
          >
            {group.flow && (
              /* One cell per column rather than a colSpan over several: the
                 Category and Status columns collapse below `sm`, and a span
                 counted for six columns misaligns the subtotal on four. */
              <tr className="bg-gray-100 dark:bg-gray-700/60">
                <th
                  colSpan={3}
                  scope="colgroup"
                  className="px-2 sm:px-4 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase"
                >
                  {group.flow === 'credit'
                    ? t('list.groupCredits', { count: group.rows.length })
                    : t('list.groupDebits', { count: group.rows.length })}
                </th>
                <td className="hidden sm:table-cell" />
                <td className="px-2 sm:px-4 py-2 text-right text-xs font-semibold text-gray-600 dark:text-gray-300">
                  {t('list.groupSubtotal', {
                    amount: formatCurrency(group.subtotal),
                  })}
                </td>
                <td className="hidden sm:table-cell" />
                <td className="hidden sm:table-cell" />
              </tr>
            )}
            {group.rows.map((transaction) => {
              const staleReason = staleByRow.get(transaction.id);
              const isSelected = selectedIds.has(transaction.id);
              return (
                <tr
                  key={transaction.id}
                  data-testid={`reconcile-row-${transaction.id}`}
                  data-stale={staleReason ?? undefined}
                  className={`cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : staleReason
                        ? STALE_ROW_CLASS
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                  }`}
                  {...getRowHandlers(transaction)}
                >
                  <td className="px-2 sm:px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(transaction.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={t('list.selectRow', {
                        payee: payeeDisplay(transaction) || '',
                      })}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                    />
                  </td>
                  <td className={`px-2 sm:px-4 ${compactPadding.date} py-3 text-sm text-gray-900 dark:text-gray-100`}>
                    {/* flex-wrap so the stale chip drops under the date on a
                        phone instead of widening the column past it. */}
                    <span className="flex flex-wrap items-center gap-2">
                      {compactMobileDates ? (
                        <>
                          <span className="sm:hidden whitespace-nowrap">
                            {formatDateWithoutYear(transaction.transactionDate)}
                          </span>
                          <span className="hidden sm:inline whitespace-nowrap">
                            {formatDate(transaction.transactionDate)}
                          </span>
                        </>
                      ) : (
                        <span className="whitespace-nowrap">
                          {formatDate(transaction.transactionDate)}
                        </span>
                      )}
                      {staleReason && (
                        <span
                          className="inline-flex items-center rounded-full bg-amber-200 dark:bg-amber-800 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-100"
                          title={
                            staleReason === 'missed'
                              ? t('stale.missedTooltip')
                              : t('stale.overdueTooltip')
                          }
                        >
                          {staleReason === 'missed'
                            ? t('stale.missedChip')
                            : t('stale.overdueChip')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td
                    className={`px-2 sm:px-4 ${compactPadding.payee} py-3 text-sm text-gray-900 dark:text-gray-100 ${
                      compactMobileDates ? 'max-w-[160px]' : 'max-w-[110px]'
                    } sm:max-w-none overflow-hidden`}
                  >
                    {payeeDisplay(transaction) || '-'}
                  </td>
                  <td className="hidden sm:table-cell px-2 sm:px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {transaction.category?.name || '-'}
                  </td>
                  <td
                    className={`px-2 sm:px-4 py-3 text-sm text-right whitespace-nowrap font-medium ${
                      Number(transaction.amount) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {formatCurrency(Number(transaction.amount))}
                  </td>
                  <td className="hidden sm:table-cell px-2 sm:px-4 py-3 text-center">
                    <StatusCellButton
                      status={transaction.status}
                      dense
                      onCycle={() => onCycleStatus(transaction)}
                    />
                  </td>
                  <td
                    className="hidden sm:table-cell px-2 sm:px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {transaction.status === TransactionStatus.RECONCILED &&
                    reconciledLocked ? (
                      <span className="block text-right text-xs text-gray-400 dark:text-gray-500">
                        {t('list.lockedRow')}
                      </span>
                    ) : (
                      <RowActions
                        actions={buildActions(transaction)}
                        density="compact"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>

      {/* Long-press / right-click action sheet */}
      <RowActionSheet
        isOpen={sheetTransaction !== null}
        title={sheetTransaction ? payeeDisplay(sheetTransaction) || '-' : ''}
        subtitle={
          sheetTransaction
            ? sheetLocked
              ? t('list.lockedRow')
              : formatDate(sheetTransaction.transactionDate)
            : undefined
        }
        actions={
          sheetTransaction
            ? sheetLocked
              ? buildActions(sheetTransaction).map((action) => ({ ...action, disabled: true }))
              : buildActions(sheetTransaction)
            : []
        }
        onClose={() => setSheetTransaction(null)}
      />
    </div>
  );
}
