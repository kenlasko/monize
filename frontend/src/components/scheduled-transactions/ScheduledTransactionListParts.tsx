'use client';

import { isPast, isToday, addDays, isBefore } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useCallback, type JSX } from 'react';
import toast from 'react-hot-toast';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { getErrorMessage } from '@/lib/errors';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { EmptyState } from '@/components/ui/EmptyState';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

/**
 * The pieces of the bills list that carry no `ui-conventions` fingerprint.
 *
 * `ScheduledTransactionList.tsx` is on the recorded row-hover, divide-string and
 * pill baselines, and those baselines are keyed PER FILE -- so everything that
 * spells one of them (the row `<tr>`, the category / auto-post / due-status /
 * "modified" chips) stays in that file, and only these fingerprint-free pieces
 * live here. That is also why this file exists at all: the phone card branch
 * would otherwise take the list past the repo's 800-line ceiling.
 */

/** The three row actions that go through the confirmation dialog. */
export type ConfirmAction = 'post' | 'skip' | 'delete';

/** Which schedule the confirmation dialog is open over, and for which action. */
export interface ConfirmState {
  isOpen: boolean;
  action: ConfirmAction | null;
  transaction: ScheduledTransaction | null;
}

export interface ScheduledActionLabels {
  post: string;
  skip: string;
  editOccurrence: string;
  editSchedule: string;
  delete: string;
}

export interface ScheduledActionHandlers {
  onPost?: (transaction: ScheduledTransaction) => void;
  onOpenConfirm: (action: 'post' | 'skip' | 'delete', transaction: ScheduledTransaction) => void;
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
}

/**
 * Builds the standard row actions for a scheduled transaction. Shared by the
 * desktop `RowActions` cell and the mobile `RowActionSheet` -- which is also
 * what makes the phone card's dropped Actions column safe: the long-press and
 * right-click sheet offers exactly these.
 */
export function buildScheduledActions(
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

/** Label plus chip colour for how close an occurrence is to its due date. */
export interface DueDateStatus {
  label: string;
  className: string;
}

/**
 * Whether an occurrence is overdue, due today or due soon -- one decision, read
 * by the tier row (twice: the phone sub-line under the name and the Schedule
 * cell) and by the phone card. It answers `null` for a date far enough out that
 * the list says nothing about it, which is a known state rather than an unknown
 * one.
 *
 * It stays a hook rather than a plain function because the labels are
 * translated, and the row compares the returned label against
 * `list.dueDateStatus.overdue` to decide the overdue row tint.
 */
export function useDueDateStatus(): (nextDueDate: string | undefined | null) => DueDateStatus | null {
  const t = useTranslations('scheduledTransactions');
  return useCallback(
    (nextDueDate: string | undefined | null) => {
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
    },
    [t],
  );
}

/**
 * The Amount column's sign, colour and formatting -- one closure, handed to
 * BOTH of the row's layouts so a layout mode never re-decides a colour.
 *
 * `null` (and a value that is not a number) renders the muted placeholder
 * rather than a zero: an occurrence the server could not price is unknown, not
 * free. That placeholder is the tier table's own and is deliberately unchanged
 * here -- see the list's follow-ups for why it is not yet `UnknownAmount`.
 */
export function useScheduledAmountFormatter(): (
  amount: number | null | undefined,
  currencyCode?: string,
) => JSX.Element {
  const { formatCurrency } = useNumberFormat();
  return useCallback(
    (amount: number | null | undefined, currencyCode?: string) => {
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
    },
    [formatCurrency],
  );
}

/**
 * Runs one confirmed row action against the API and reports the outcome.
 *
 * The caller keeps the in-flight bookkeeping (which row is busy, closing the
 * dialog, refreshing the list); this owns only the call and its two toasts, so
 * both are written once whichever layout the row was tapped in. It answers
 * whether the write SUCCEEDED, because a failed action must not trigger the
 * caller's refresh -- a refetch is a claim that something changed.
 */
export async function runScheduledAction(
  action: 'post' | 'skip' | 'delete',
  transactionId: string,
  t: (key: string) => string,
): Promise<boolean> {
  try {
    switch (action) {
      case 'post':
        await scheduledTransactionsApi.post(transactionId);
        toast.success(t('list.toasts.posted'));
        break;
      case 'skip':
        await scheduledTransactionsApi.skip(transactionId);
        toast.success(t('list.toasts.skipped'));
        break;
      case 'delete':
        await scheduledTransactionsApi.delete(transactionId);
        toast.success(t('list.toasts.deleted'));
        break;
    }
    return true;
  } catch (error) {
    const messages = {
      post: t('list.toasts.postFailed'),
      skip: t('list.toasts.skipFailed'),
      delete: t('list.toasts.deleteFailed'),
    };
    toast.error(getErrorMessage(error, messages[action]));
    return false;
  }
}

/** Copy and severity for the post / skip / delete confirmation. */
export function scheduledConfirmConfig(
  action: 'post' | 'skip' | 'delete' | null,
  transaction: ScheduledTransaction | null,
  t: (key: string, values?: Record<string, string | number>) => string,
) {
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
}

/**
 * What the bills list shows with nothing to list. It replaces the table
 * outright, which is why neither layout has a `colSpan` empty-state row to
 * reconcile with the wrapped layout's single column.
 */
export function ScheduledEmptyState() {
  const t = useTranslations('scheduledTransactions');
  return (
    <EmptyState
      className="bg-gray-50 dark:bg-gray-800 rounded-lg"
      icon={
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      }
      title={t('list.empty.title')}
      description={t('list.empty.subtitle')}
    />
  );
}
