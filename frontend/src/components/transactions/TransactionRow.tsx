'use client';

import { memo, useState, useRef, useEffect, useCallback, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { getIconComponent } from '@/components/ui/IconPicker';
import { Transaction, TransactionSplit, TransactionStatus } from '@/types/transaction';
import { CategoryBudgetStatus } from '@/types/budget';
import { DensityLevel } from '@/hooks/useTableDensity';
import { formatAmountWithCommas, getDecimalPlacesForCurrency } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';

const INVESTMENT_ACTION_LABELS: Record<string, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  SPLIT: 'Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  REINVEST: 'Reinvest',
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
};

function describeInvestmentSplit(split: TransactionSplit, uncategorizedLabel: string): string {
  const inv = split.investmentTransaction;
  if (!inv) return uncategorizedLabel;
  const action = INVESTMENT_ACTION_LABELS[inv.action] || inv.action;
  const symbol = inv.security?.symbol;
  return symbol ? `${action}: ${symbol}` : action;
}

function CopyDropdown({ density, onDuplicate, onScheduleRecurring }: {
  density: DensityLevel;
  onDuplicate?: () => void;
  onScheduleRecurring?: () => void;
}) {
  const t = useTranslations('transactions');
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.right });
    }
  }, []);

  useClickOutside([dropdownRef, buttonRef], () => setIsOpen(false), { enabled: isOpen });

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();
    const handleScroll = () => setIsOpen(false);
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [isOpen, updatePosition]);

  // If only one action is available, render a simple button
  if (onDuplicate && !onScheduleRecurring) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        title={t('row.copyOptions.duplicateTitle')}
      >
        {density === 'dense' ? (
          <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        ) : t('row.copyOptions.copy')}
      </button>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); setIsOpen(prev => !prev); }}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        title={t('row.copyOptions.title')}
      >
        {density === 'dense' ? (
          <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        ) : (
          <span className="inline-flex items-center gap-0.5">
            {t('row.copyOptions.copy')}
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        )}
      </button>
      {isOpen && createPortal(
        <div ref={dropdownRef} className="fixed z-50 w-56 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black/5 dark:ring-white/10 py-1" style={{ top: dropdownPos.top, left: dropdownPos.left, transform: 'translateX(-100%)' }}>
          {onDuplicate && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsOpen(false); onDuplicate(); }}
              className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t('row.copyOptions.duplicate')}
            </button>
          )}
          {onScheduleRecurring && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsOpen(false); onScheduleRecurring(); }}
              className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap"
            >
              <svg className="w-4 h-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {t('row.copyOptions.scheduleRecurring')}
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

export interface TransactionRowProps {
  transaction: Transaction;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  isSingleAccountView: boolean;
  showRunningBalance?: boolean;
  runningBalance: number | undefined;
  /** When set, a filter has reduced which splits are visible.  Show this
   *  amount instead of the full transaction amount and flag as partial. */
  displayAmount?: number;
  isDeleting: boolean;
  formatDate: (date: string) => string;
  formatAmount: (amount: number, currencyCode?: string) => JSX.Element;
  formatBalance: (balance: number, currencyCode?: string) => JSX.Element;
  onRowClick: (transaction: Transaction) => void;
  onLongPressStart: (transaction: Transaction, e: React.MouseEvent) => void;
  onLongPressStartTouch: (transaction: Transaction, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onContextMenu: (transaction: Transaction, e: React.MouseEvent) => void;
  onPayeeClick?: (payeeId: string) => void;
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
  onTagClick?: (tagId: string) => void;
  onCycleStatus: (transaction: Transaction) => void;
  onEdit?: (transaction: Transaction) => void;
  onDuplicate?: (transaction: Transaction) => void;
  onScheduleRecurring?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  isSelected?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  categoryColorMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
  isFuture?: boolean;
}

export const TransactionRow = memo(function TransactionRow({
  transaction,
  index,
  density,
  cellPadding,
  isSingleAccountView,
  showRunningBalance = isSingleAccountView,
  runningBalance,
  displayAmount,
  isDeleting,
  formatDate,
  formatAmount,
  formatBalance,
  onRowClick,
  onLongPressStart,
  onLongPressStartTouch,
  onLongPressEnd,
  onTouchMove,
  onContextMenu,
  onPayeeClick,
  onTransferClick,
  onCategoryClick,
  onTagClick,
  onCycleStatus,
  onEdit,
  onDuplicate,
  onScheduleRecurring,
  onDeleteClick,
  isSelected,
  selectionMode,
  onToggleSelection,
  categoryColorMap,
  budgetStatusMap,
  isFuture,
}: TransactionRowProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const { formatCurrency } = useNumberFormat();
  const isVoid = transaction.status === TransactionStatus.VOID;
  // Prefer the denormalized payeeName, but fall back to the linked payee's name
  // so a transaction that has only payeeId set (e.g. created via the REST API
  // without payeeName) still shows the payee instead of a dash.
  const payeeLabel = transaction.payeeName || transaction.payee?.name || null;
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;

  return (
    <tr
      onClick={() => onRowClick(transaction)}
      onContextMenu={(e) => onContextMenu(transaction, e)}
      onMouseDown={(e) => onLongPressStart(transaction, e)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(transaction, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 select-none touch-manipulation ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${isVoid ? 'opacity-50' : ''} ${isFuture && !isVoid ? 'opacity-60' : ''} ${onEdit ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
    >
      {selectionMode && (
        <td className={`${cellPadding} whitespace-nowrap w-10`} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={() => onToggleSelection?.()}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
          />
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
        {formatDate(transaction.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''} hidden lg:table-cell`}>
        {transaction.account?.name || '-'}
      </td>
      <td className={`${cellPadding} max-w-[100px] sm:max-w-none overflow-hidden`}>
        {transaction.payeeId && onPayeeClick ? (
          <button
            onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
            className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate sm:max-w-[280px] text-left ${isVoid ? 'line-through' : ''}`}
            title={t('list.row.editPayeeTitle', { name: payeeLabel ?? '' })}
          >
            {payeeLabel || '-'}
          </button>
        ) : (
          <div
            className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate sm:max-w-[280px] ${isVoid ? 'line-through' : ''}`}
            title={payeeLabel || undefined}
          >
            {payeeLabel || '-'}
          </div>
        )}
        {density === 'normal' && transaction.referenceNumber && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {t('list.row.ref', { number: transaction.referenceNumber })}
          </div>
        )}
      </td>
      <td className={`${cellPadding} ${density !== 'normal' ? 'whitespace-nowrap' : ''} hidden min-[900px]:table-cell`}>
        {transaction.linkedInvestmentTransactionId ? (
          <span
            className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
            title="This transaction is linked to an investment transaction"
          >
            {t('list.row.investmentLabel')}
          </span>
        ) : transaction.isTransfer ? (
          // A transfer shows where the money moved (the linked-account arrow
          // chip). When it also carries a spending category (e.g. a monthly
          // investment contribution surfaced in the category breakdown), show
          // the category chip alongside the arrow so the assigned category is
          // visible, not hidden behind the transfer chip.
          <span className="inline-flex items-center gap-1 flex-wrap">
            {transaction.category &&
              (onCategoryClick ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }}
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[140px] hover:opacity-80 transition-opacity ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={t('list.row.filterByCategory', { name: transaction.category.name })}
                >
                  {transaction.category.name}
                </button>
              ) : (
                <span
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[140px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={transaction.category.name}
                >
                  {transaction.category.name}
                </span>
              ))}
            {onTransferClick && transaction.linkedTransaction?.account?.id && transaction.linkedTransactionId ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTransferClick(transaction.linkedTransaction!.account!.id, transaction.linkedTransactionId!);
                }}
                className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                title={`Click to view in ${transaction.linkedTransaction.account.name}`}
              >
                {Number(transaction.amount) < 0
                  ? `\u2192 ${transaction.linkedTransaction.account.name}`
                  : `${transaction.linkedTransaction.account.name} \u2192`}
              </button>
            ) : (
              <span
                className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                title={transaction.linkedTransaction?.account?.name
                  ? t('list.row.transferTitle', { direction: Number(transaction.amount) < 0 ? 'to' : 'from', name: transaction.linkedTransaction.account.name })
                  : t('list.row.transfer')}
              >
                {transaction.linkedTransaction?.account?.name
                  ? (Number(transaction.amount) < 0
                      ? `\u2192 ${transaction.linkedTransaction.account.name}`
                      : `${transaction.linkedTransaction.account.name} \u2192`)
                  : t('list.row.transfer')}
              </span>
            )}
          </span>
        ) : transaction.isSplit ? (
          <div>
            <span className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
              Split{transaction.splits ? ` (${transaction.splits.length})` : ''}
            </span>
            {density === 'normal' && transaction.splits && transaction.splits.length > 0 && (
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                {[...transaction.splits]
                  .sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))
                  .slice(0, 3)
                  .map((split, idx) => (
                  <div key={split.id || idx} className="truncate max-w-[180px]">
                    {split.transferAccount ? (
                      <span className="text-blue-600 dark:text-blue-400">
                        {Number(split.amount) < 0
                          ? `\u2192 ${split.transferAccount.name}`
                          : `${split.transferAccount.name} \u2192`}: {formatAmountWithCommas(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}
                      </span>
                    ) : split.investmentTransaction ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {describeInvestmentSplit(split, t('list.row.uncategorized'))}: {formatAmountWithCommas(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}
                      </span>
                    ) : (
                      <>{split.category?.name || t('list.row.uncategorized')}: {formatAmountWithCommas(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}</>
                    )}
                  </div>
                ))}
                {transaction.splits.length > 3 && (
                  <div className="text-gray-400 dark:text-gray-500">{t('list.row.splitMore', { count: transaction.splits.length - 3 })}</div>
                )}
              </div>
            )}
          </div>
        ) : transaction.category ? (
          (() => {
            const budgetStatus = budgetStatusMap?.[transaction.category!.id];
            const budgetIndicator = budgetStatus && budgetStatus.budgeted > 0 ? (
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0 ${
                  budgetStatus.percentUsed > 100
                    ? 'bg-red-500'
                    : budgetStatus.percentUsed >= 80
                      ? 'bg-amber-500'
                      : ''
                }`}
                title={
                  budgetStatus.percentUsed > 100
                    ? `Over budget: ${budgetStatus.percentUsed.toFixed(0)}% used (${formatCurrency(budgetStatus.spent, transaction.currencyCode)} / ${formatCurrency(budgetStatus.budgeted, transaction.currencyCode)})`
                    : budgetStatus.percentUsed >= 80
                      ? `Approaching limit: ${budgetStatus.percentUsed.toFixed(0)}% used (${formatCurrency(budgetStatus.remaining, transaction.currencyCode)} remaining)`
                      : undefined
                }
              />
            ) : null;

            return onCategoryClick ? (
              <span className="inline-flex items-center">
                <button
                  onClick={(e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }}
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] hover:opacity-80 transition-opacity ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={t('list.row.filterByCategory', { name: transaction.category!.name })}
                >
                  {transaction.category!.name}
                </button>
                {budgetIndicator}
              </span>
            ) : (
              <span className="inline-flex items-center">
                <span
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={transaction.category!.name}
                >
                  {transaction.category!.name}
                </span>
                {budgetIndicator}
              </span>
            );
          })()
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 hidden 2xl:table-cell`}>
        <div
          className={`truncate max-w-[320px] ${isVoid ? 'line-through' : ''}`}
          title={transaction.description || undefined}
        >
          {transaction.description || '-'}
        </div>
      </td>
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 hidden 2xl:table-cell`}>
        <div
          className={`truncate max-w-[160px] ${isVoid ? 'line-through' : ''}`}
          title={transaction.referenceNumber || undefined}
        >
          {transaction.referenceNumber || '-'}
        </div>
      </td>
      <td className={`${cellPadding} text-sm hidden xl:table-cell`}>
        {transaction.tags && transaction.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {transaction.tags.map((tag) => onTagClick ? (
              <button
                key={tag.id}
                onClick={(e) => { e.stopPropagation(); onTagClick(tag.id); }}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
                  color: tag.color || '#6b7280',
                }}
                title={t('list.row.filterByTag', { name: tag.name })}
              >
                {tag.icon && (
                  <span className="w-3 h-3 flex-shrink-0 [&>svg]:w-3 [&>svg]:h-3">
                    {getIconComponent(tag.icon)}
                  </span>
                )}
                {tag.name}
              </button>
            ) : (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
                style={{
                  backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
                  color: tag.color || '#6b7280',
                }}
                title={tag.name}
              >
                {tag.icon && (
                  <span className="w-3 h-3 flex-shrink-0 [&>svg]:w-3 [&>svg]:h-3">
                    {getIconComponent(tag.icon)}
                  </span>
                )}
                {tag.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
        {displayAmount !== undefined ? (
          <span
            title={t('list.row.filteredAmountTitle', { amount: formatAmountWithCommas(Math.abs(transaction.amount), getDecimalPlacesForCurrency(transaction.currencyCode)) })}
            className="inline-flex items-center gap-1 justify-end"
          >
            {formatAmount(displayAmount, transaction.currencyCode)}
            <span className="text-purple-500 dark:text-purple-400 text-xs font-normal">*</span>
          </span>
        ) : (
          formatAmount(transaction.amount, transaction.currencyCode)
        )}
      </td>
      {showRunningBalance && (
        <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
          {runningBalance !== undefined
            ? formatBalance(runningBalance, transaction.currencyCode)
            : '-'}
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-center hidden min-[1400px]:table-cell`}>
        <button
          onClick={(e) => { e.stopPropagation(); onCycleStatus(transaction); }}
          className="text-sm px-3 py-1.5 -my-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title={t('list.status.cycleTitle')}
        >
          {transaction.status === TransactionStatus.RECONCILED ? (
            <span className="text-blue-600 dark:text-blue-400">{density === 'dense' ? t('list.status.reconciledDense') : t('list.status.reconciled')}</span>
          ) : transaction.status === TransactionStatus.CLEARED ? (
            <span className="text-green-600 dark:text-green-400">{density === 'dense' ? t('list.status.clearedDense') : t('list.status.cleared')}</span>
          ) : transaction.status === TransactionStatus.VOID ? (
            <span className="text-red-600 dark:text-red-400">{density === 'dense' ? t('list.status.voidDense') : t('list.status.void').toUpperCase()}</span>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">{density === 'dense' ? t('list.status.pendingDense') : t('list.status.pending')}</span>
          )}
        </button>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2 hidden min-[480px]:table-cell sticky right-0 ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(transaction); }}
            className={transaction.linkedInvestmentTransactionId
              ? "text-emerald-600 hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
              : "text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
            }
            title={transaction.linkedInvestmentTransactionId ? t('list.row.linkedInvestmentTitle') : undefined}
          >
            {transaction.linkedInvestmentTransactionId
              ? (density === 'dense' ? '\uD83D\uDCC8' : t('list.row.viewButton'))
              : (density === 'dense' ? '\u270E' : tc('edit'))}
          </button>
        )}
        {!transaction.linkedInvestmentTransactionId && (onDuplicate || onScheduleRecurring) && (
          <CopyDropdown
            density={density}
            onDuplicate={onDuplicate ? () => onDuplicate(transaction) : undefined}
            onScheduleRecurring={onScheduleRecurring ? () => onScheduleRecurring(transaction) : undefined}
          />
        )}
        {!transaction.linkedInvestmentTransactionId && (
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteClick(transaction); }}
            disabled={isDeleting}
            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
          >
            {isDeleting ? '...' : density === 'dense' ? '\u2715' : tc('delete')}
          </button>
        )}
      </td>
    </tr>
  );
});
