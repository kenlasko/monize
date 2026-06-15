'use client';

import { useState, memo, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { isPast, isToday, addDays, isBefore } from 'date-fns';
import toast from 'react-hot-toast';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { parseLocalDate } from '@/lib/utils';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { computeInvestmentCashImpact } from '@/lib/investmentCashImpact';
import { InvestmentAction } from '@/types/investment';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

interface ScheduledActionLabels {
  post: string;
  skip: string;
  editOccurrence: string;
  editSchedule: string;
  delete: string;
}

interface ScheduledActionHandlers {
  onPost?: (transaction: ScheduledTransaction) => void;
  onOpenConfirm: (action: 'post' | 'skip' | 'delete', transaction: ScheduledTransaction) => void;
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
}

/**
 * Builds the standard row actions for a scheduled transaction. Shared by the
 * desktop `RowActions` cell and the mobile `RowActionSheet`.
 */
function buildScheduledActions(
  transaction: ScheduledTransaction,
  isProcessing: boolean,
  labels: ScheduledActionLabels,
  handlers: ScheduledActionHandlers,
): RowAction[] {
  return [
    {
      key: 'post',
      label: labels.post,
      icon: 'post',
      tone: 'success',
      disabled: isProcessing,
      onClick: () => (handlers.onPost ? handlers.onPost(transaction) : handlers.onOpenConfirm('post', transaction)),
      hidden: !transaction.isActive,
    },
    {
      key: 'skip',
      label: labels.skip,
      icon: 'skip',
      tone: 'warning',
      disabled: isProcessing,
      onClick: () => handlers.onOpenConfirm('skip', transaction),
      hidden: !transaction.isActive || transaction.frequency === 'ONCE',
    },
    {
      key: 'editOccurrence',
      label: labels.editOccurrence,
      icon: 'schedule',
      tone: 'accent',
      onClick: () => handlers.onEditOccurrence?.(transaction),
      hidden: !handlers.onEditOccurrence || !transaction.isActive,
    },
    {
      key: 'editSchedule',
      label: labels.editSchedule,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit?.(transaction),
      hidden: !handlers.onEdit,
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      disabled: isProcessing,
      onClick: () => handlers.onOpenConfirm('delete', transaction),
    },
  ];
}

/**
 * Cash impact of a scheduled transaction occurrence, taking nextOverride into
 * account when useOverride is true. For investment-kind rows the amount column
 * isn't simply `transaction.amount`; it's derived from qty * price + commission
 * (or totalAmount for amount-only actions), and the override may carry a
 * different qty / price / total than the base row.
 */
function scheduledOccurrenceAmount(
  transaction: ScheduledTransaction,
  useOverride: boolean,
): number | null {
  if (transaction.isInvestment) {
    const action = transaction.investmentAction as InvestmentAction | null;
    if (!action) return null;
    const override = useOverride ? transaction.nextOverride : null;
    const commission = Number(transaction.investmentCommission ?? 0);

    if (action === 'BUY' || action === 'SELL' || action === 'REINVEST') {
      const qty = Number(
        override?.investmentQuantity ?? transaction.investmentQuantity ?? 0,
      );
      const price = Number(
        override?.investmentPrice ?? transaction.investmentPrice ?? 0,
      );
      if (qty <= 0 || price <= 0) return null;
      return computeInvestmentCashImpact(action, qty, price, commission);
    }
    if (action === 'DIVIDEND' || action === 'INTEREST' || action === 'CAPITAL_GAIN') {
      const total =
        override?.investmentTotalAmount ?? transaction.investmentTotalAmount;
      return total != null ? Number(total) : null;
    }
    // ADD_SHARES / REMOVE_SHARES / SPLIT -- shares move, no cash impact.
    return 0;
  }
  if (useOverride && transaction.nextOverride?.amount != null) {
    return Number(transaction.nextOverride.amount);
  }
  return Number(transaction.amount);
}
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type ConfirmAction = 'post' | 'skip' | 'delete';

interface ConfirmState {
  isOpen: boolean;
  action: ConfirmAction | null;
  transaction: ScheduledTransaction | null;
}

interface ScheduledTransactionRowProps {
  transaction: ScheduledTransaction;
  isProcessing: boolean;
  formatDate: (date: string) => string;
  formatAmount: (amount: number | null | undefined, currencyCode?: string) => JSX.Element;
  getDueDateStatus: (nextDueDate: string | undefined | null) => { label: string; className: string } | null;
  getRowHandlers: (transaction: ScheduledTransaction) => LongPressRowHandlers;
  onPost?: (transaction: ScheduledTransaction) => void;
  onOpenConfirm: (action: 'post' | 'skip' | 'delete', transaction: ScheduledTransaction) => void;
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
  categoryColorMap?: Map<string, string | null>;
}

const ScheduledTransactionRow = memo(function ScheduledTransactionRow({
  transaction,
  isProcessing,
  formatDate,
  formatAmount,
  getDueDateStatus,
  getRowHandlers,
  onPost,
  onOpenConfirm,
  onEdit,
  onEditOccurrence,
  categoryColorMap,
}: ScheduledTransactionRowProps) {
  const t = useTranslations('scheduledTransactions');
  const actions = buildScheduledActions(
    transaction,
    isProcessing,
    {
      post: t('list.contextMenu.postTransaction'),
      skip: t('list.contextMenu.skipOccurrence'),
      editOccurrence: t('list.contextMenu.editOccurrence'),
      editSchedule: t('list.contextMenu.editSchedule'),
      delete: t('list.contextMenu.delete'),
    },
    { onPost, onOpenConfirm, onEdit, onEditOccurrence },
  );
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;
  const effectiveDueDate = transaction.nextOverride?.overrideDate || transaction.nextDueDate || '';
  const dueDateStatus = effectiveDueDate ? getDueDateStatus(effectiveDueDate) : null;
  const payee = transaction.payeeName || transaction.payee?.name;

  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${!transaction.isActive ? 'opacity-50' : ''} ${dueDateStatus?.label === t('list.dueDateStatus.overdue') ? 'bg-red-50 dark:bg-red-900/10' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(transaction)}
    >
      {/* Name / Payee */}
      <td className="px-4 py-3">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{transaction.name}</div>
        {payee && payee !== transaction.name && (
          <div className="text-xs text-gray-500 dark:text-gray-400">{payee}</div>
        )}
        {/* Mobile-only: show schedule info under name */}
        <div className="sm:hidden mt-0.5">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {effectiveDueDate ? formatDate(effectiveDueDate) : '\u2014'}
            {' \u00b7 '}{t(`frequency.${transaction.frequency}`)}
          </div>
          {dueDateStatus && (
            <span className={`inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 mt-0.5 ${dueDateStatus.className}`}>
              {dueDateStatus.label}
            </span>
          )}
        </div>
      </td>

      {/* Account */}
      <td className="px-4 py-3 hidden sm:table-cell">
        <div className="text-sm text-gray-900 dark:text-gray-100">{transaction.account?.name}</div>
      </td>

      {/* Category */}
      <td className="px-4 py-3 hidden md:table-cell">
        {transaction.isInvestment ? (
          <span
            className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
            title={
              transaction.investmentSecurity
                ? `${transaction.investmentAction || ''} ${transaction.investmentSecurity.symbol || transaction.investmentSecurity.name}`.trim()
                : transaction.investmentAction || 'Investment'
            }
          >
            {transaction.investmentSecurity?.symbol
              ? `${transaction.investmentAction || 'Investment'}: ${transaction.investmentSecurity.symbol}`
              : transaction.investmentAction || 'Investment'}
          </span>
        ) : transaction.isTransfer ? (
          <span
            className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
            title={`Transfer to ${transaction.transferAccount?.name || 'account'}`}
          >
            Transfer
          </span>
        ) : transaction.isSplit ? (
          <span
            className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
            title={transaction.splits?.map(s => s.category?.name || 'Uncategorized').join(', ')}
          >
            Split ({transaction.splits?.length || 0})
          </span>
        ) : transaction.category ? (
          <span
            className="inline-flex text-xs font-medium rounded-full px-2 py-0.5"
            style={{
              backgroundColor: categoryColor
                ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                : 'var(--category-bg-base, #e5e7eb)',
              color: categoryColor
                ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                : 'var(--category-text-base, #6b7280)',
            }}
          >
            {transaction.category.name}
          </span>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">{'\u2014'}</span>
        )}
      </td>

      {/* Amount */}
      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-right">
        {(() => {
          const baseAmount = scheduledOccurrenceAmount(transaction, false);
          const overrideAmount = transaction.nextOverride
            ? scheduledOccurrenceAmount(transaction, true)
            : null;
          const isModified =
            overrideAmount != null &&
            baseAmount != null &&
            Number(overrideAmount) !== Number(baseAmount);
          if (isModified) {
            return (
              <div className="flex flex-col items-end">
                <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
                  {formatAmount(baseAmount, transaction.currencyCode)}
                </span>
                <span title={t('list.modifiedAmountTitle')}>
                  {formatAmount(overrideAmount, transaction.currencyCode)}
                </span>
              </div>
            );
          }
          return formatAmount(baseAmount, transaction.currencyCode);
        })()}
      </td>

      {/* Schedule (Frequency + Next Due + Remaining) */}
      <td className="px-4 py-3 hidden sm:table-cell">
        <div className="text-sm text-gray-900 dark:text-gray-100">
          {/* Show override date if it differs from the original next due date */}
          {transaction.nextOverride?.overrideDate &&
           transaction.nextDueDate &&
           transaction.nextOverride.overrideDate !== String(transaction.nextDueDate).split('T')[0] ? (
            <span className="inline-flex flex-col align-middle">
              <span className="text-xs text-gray-400 dark:text-gray-500 line-through leading-tight">
                {formatDate(transaction.nextDueDate)}
              </span>
              <span className="leading-tight" title="Date modified for this occurrence">
                {formatDate(transaction.nextOverride.overrideDate)}
              </span>
            </span>
          ) : (
            transaction.nextDueDate ? formatDate(transaction.nextDueDate) : '\u2014'
          )}
          {dueDateStatus && (
            <span
              className={`ml-1.5 inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 ${dueDateStatus.className}`}
            >
              {dueDateStatus.label}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {t(`frequency.${transaction.frequency}`)}
          {transaction.occurrencesRemaining !== null && (
            <span className="ml-1">{'\u00b7'} {t('list.occurrencesRemaining', { count: transaction.occurrencesRemaining })}</span>
          )}
          {transaction.overrideCount !== undefined && transaction.overrideCount > 0 && (
            <span
              className="ml-1.5 inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
              title={t('list.modifiedTitle', { count: transaction.overrideCount })}
            >
              {t('list.modifiedBadge', { count: transaction.overrideCount })}
            </span>
          )}
        </div>
      </td>

      {/* Auto-post */}
      <td className="px-4 py-3 text-center hidden md:table-cell">
        {transaction.autoPost ? (
          <span
            className="inline-flex items-center text-xs font-medium rounded-full px-2 py-0.5 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
            title={t('list.autoPostTitle')}
          >
            {t('list.autoPostBadge')}
          </span>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">{'\u2014'}</span>
        )}
      </td>

      {/* Actions */}
      <td className={`px-4 py-3 whitespace-nowrap text-right hidden min-[480px]:table-cell sticky right-0 ${dueDateStatus?.label === t('list.dueDateStatus.overdue') ? 'bg-red-50 dark:bg-red-900/10' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`} onClick={(e) => e.stopPropagation()}>
        <RowActions actions={actions} density="compact" />
      </td>
    </tr>
  );
});

interface ScheduledTransactionListProps {
  transactions: ScheduledTransaction[];
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
  onPost?: (transaction: ScheduledTransaction) => void;
  onRefresh?: () => void;
  categoryColorMap?: Map<string, string | null>;
}

export function ScheduledTransactionList({
  transactions,
  onEdit,
  onEditOccurrence,
  onPost,
  onRefresh,
  categoryColorMap,
}: ScheduledTransactionListProps) {
  const t = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    isOpen: false,
    action: null,
    transaction: null,
  });

  // Long-press opens a per-row action sheet on mobile (and via right-click).
  const [contextTransaction, setContextTransaction] = useState<ScheduledTransaction | null>(null);

  const { getRowHandlers } = useLongPress<ScheduledTransaction>({
    onLongPress: setContextTransaction,
    onClick: (transaction) => onEdit?.(transaction),
  });

  const openConfirm = (action: ConfirmAction, transaction: ScheduledTransaction) => {
    setConfirmState({ isOpen: true, action, transaction });
  };

  const closeConfirm = () => {
    setConfirmState({ isOpen: false, action: null, transaction: null });
  };

  const handleConfirm = async () => {
    const { action, transaction } = confirmState;
    if (!action || !transaction) return;

    closeConfirm();
    setActionInProgress(transaction.id);

    try {
      switch (action) {
        case 'post':
          await scheduledTransactionsApi.post(transaction.id);
          toast.success(t('list.toasts.posted'));
          break;
        case 'skip':
          await scheduledTransactionsApi.skip(transaction.id);
          toast.success(t('list.toasts.skipped'));
          break;
        case 'delete':
          await scheduledTransactionsApi.delete(transaction.id);
          toast.success(t('list.toasts.deleted'));
          break;
      }
      onRefresh?.();
    } catch (error) {
      const messages = {
        post: t('list.toasts.postFailed'),
        skip: t('list.toasts.skipFailed'),
        delete: t('list.toasts.deleteFailed'),
      };
      toast.error(getErrorMessage(error, messages[action]));
    } finally {
      setActionInProgress(null);
    }
  };

  const getConfirmConfig = () => {
    const { action, transaction } = confirmState;
    if (!action || !transaction) {
      return { title: '', message: '', confirmLabel: '', variant: 'info' as const };
    }

    switch (action) {
      case 'post':
        return {
          title: t('list.confirmPost.title'),
          message: t('list.confirmPost.message', { name: transaction.name, account: transaction.account?.name || 'account' }),
          confirmLabel: t('list.confirmPost.confirmLabel'),
          variant: 'info' as const,
        };
      case 'skip':
        return {
          title: t('list.confirmSkip.title'),
          message: t('list.confirmSkip.message', { name: transaction.name }),
          confirmLabel: t('list.confirmSkip.confirmLabel'),
          variant: 'warning' as const,
        };
      case 'delete':
        return {
          title: t('list.confirmDelete.title'),
          message: t('list.confirmDelete.message', { name: transaction.name }),
          confirmLabel: t('list.confirmDelete.confirmLabel'),
          variant: 'danger' as const,
        };
    }
  };

  const formatAmount = (amount: number | null | undefined, currencyCode?: string) => {
    if (amount == null) return <span className="text-gray-400">—</span>;
    const numAmount = Number(amount);
    if (isNaN(numAmount)) return <span className="text-gray-400">—</span>;

    const isNegative = numAmount < 0;
    const absAmount = Math.abs(numAmount);
    const formatted = formatCurrency(absAmount, currencyCode);

    return (
      <span className={isNegative ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>
        {isNegative ? '-' : '+'}
        {formatted}
      </span>
    );
  };

  const getDueDateStatus = (nextDueDate: string | undefined | null) => {
    if (!nextDueDate) return null;

    try {
      const date = parseLocalDate(nextDueDate);
      if (!date || isNaN(date.getTime())) return null;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (isPast(date) && !isToday(date)) {
        return { label: t('list.dueDateStatus.overdue'), className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' };
      }
      if (isToday(date)) {
        return { label: t('list.dueDateStatus.dueToday'), className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' };
      }
      if (isBefore(date, addDays(today, 7))) {
        return { label: t('list.dueDateStatus.dueSoon'), className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' };
      }
      return null;
    } catch {
      return null;
    }
  };

  if (transactions.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <svg
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">{t('list.empty.title')}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('list.empty.subtitle')}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('list.columns.namePayee')}
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">
              {t('list.columns.account')}
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">
              {t('list.columns.category')}
            </th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('list.columns.amount')}
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">
              {t('list.columns.schedule')}
            </th>
            <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">
              {t('list.columns.auto')}
            </th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800">
              {t('list.columns.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {transactions.map((transaction) => (
            <ScheduledTransactionRow
              key={transaction.id}
              transaction={transaction}
              isProcessing={actionInProgress === transaction.id}
              formatDate={formatDate}
              formatAmount={formatAmount}
              getDueDateStatus={getDueDateStatus}
              getRowHandlers={getRowHandlers}
              onPost={onPost}
              onOpenConfirm={openConfirm}
              onEdit={onEdit}
              onEditOccurrence={onEditOccurrence}
              categoryColorMap={categoryColorMap}
            />
          ))}
        </tbody>
      </table>

      {/* Long-press action sheet */}
      <RowActionSheet
        isOpen={!!contextTransaction}
        title={contextTransaction?.name ?? ''}
        subtitle={contextTransaction
          ? `${t(`frequency.${contextTransaction.frequency}`)}${!contextTransaction.isActive ? t('list.inactiveSuffix') : ''}`
          : undefined}
        actions={contextTransaction
          ? buildScheduledActions(
              contextTransaction,
              actionInProgress === contextTransaction.id,
              {
                post: t('list.contextMenu.postTransaction'),
                skip: t('list.contextMenu.skipOccurrence'),
                editOccurrence: t('list.contextMenu.editOccurrence'),
                editSchedule: t('list.contextMenu.editSchedule'),
                delete: t('list.contextMenu.delete'),
              },
              { onPost, onOpenConfirm: openConfirm, onEdit, onEditOccurrence },
            )
          : []}
        onClose={() => setContextTransaction(null)}
      />

      <ConfirmDialog
        isOpen={confirmState.isOpen}
        onConfirm={handleConfirm}
        onCancel={closeConfirm}
        {...getConfirmConfig()}
      />
    </div>
  );
}
