'use client';

import { memo, useState, useRef, useEffect, useCallback, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { getIconComponent } from '@/components/ui/IconPicker';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { Transaction, TransactionSplit, TransactionStatus } from '@/types/transaction';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { CategoryBudgetStatus } from '@/types/budget';
import { DensityLevel } from '@/hooks/useTableDensity';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL } from '@/hooks/useHighlightTarget';
import { formatAmountWithCommas, getDecimalPlacesForCurrency } from '@/lib/format';
import { foreignTransactionFee } from '@/lib/fx-fees';
import { transferDirection } from '@/lib/transfer-label';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { StaleUnreconciledReason } from '@/lib/stale-reconciliation';

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
  /** Joint accounts: hides the delete button when the grant lacks delete. */
  hideDelete?: boolean;
  onEdit?: (transaction: Transaction) => void;
  onDuplicate?: (transaction: Transaction) => void;
  onScheduleRecurring?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  isSelected?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  categoryColorMap?: Map<string, string | null>;
  /** Inherited-aware icon per category id; see buildCategoryIconMap. */
  categoryIconMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
  isFuture?: boolean;
  /** Flash and scroll to this row (e.g. when arriving from a deep link). */
  isHighlighted?: boolean;
  /** Render the foreign-currency columns (paid currency, paid amount, fee paid). */
  showFxColumns?: boolean;
  /**
   * Why this row is overdue for reconciliation, from `classifyStaleRow`.
   * Undefined means either "not stale" or "no information" -- the caller only
   * supplies it for accounts the user actually reconciles, and a page that
   * could not load that context supplies it for none.
   */
  staleReason?: StaleUnreconciledReason;
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
  hideDelete,
  onEdit,
  onDuplicate,
  onScheduleRecurring,
  onDeleteClick,
  isSelected,
  selectionMode,
  onToggleSelection,
  categoryColorMap,
  categoryIconMap,
  budgetStatusMap,
  isFuture,
  isHighlighted,
  showFxColumns = false,
  staleReason,
}: TransactionRowProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  // The reconciliation chips live in the reconcile catalog so the register and
  // the reconcile table say the same thing about the same row.
  const tr = useTranslations('reconcile');
  const { formatCurrency } = useNumberFormat();
  const isVoid = transaction.status === TransactionStatus.VOID;

  // When this row is the deep-link target, scroll it into view once it mounts
  // so the user lands on it rather than hunting through the page.
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (isHighlighted) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isHighlighted]);
  // Prefer the denormalized payeeName, then the linked payee's name (a
  // transaction with only payeeId set still shows its payee), then -- for a
  // transfer leg with no payee at all -- the label resolved from the linked
  // account's current name, localized (issue #1214).
  const payeeDisplay = usePayeeDisplay();
  const payeeLabel = payeeDisplay(transaction);

  // Fee paid, as a positive cost in the account currency. 0 means no fee
  // applied (e.g. recorded before the account's fee percentage was configured).
  const fxFeePaid = showFxColumns ? foreignTransactionFee(transaction) : 0;
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;
  // Same inheritance as the colour: the joined row carries only its own icon,
  // so a child of an icon-bearing parent needs the map to show one.
  const categoryIcon = transaction.category
    ? (categoryIconMap?.get(transaction.category.id) ?? transaction.category.icon)
    : null;

  return (
    <tr
      ref={rowRef}
      onClick={() => onRowClick(transaction)}
      onContextMenu={(e) => onContextMenu(transaction, e)}
      onMouseDown={(e) => onLongPressStart(transaction, e)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(transaction, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
      className={`group ${HOVER_ROW_ON_PAGE} select-none touch-manipulation ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${isVoid ? 'opacity-50' : ''} ${isFuture && !isVoid ? 'opacity-60' : ''} ${onEdit ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
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
        <span className={`flex items-center gap-1.5 ${isVoid ? 'line-through' : ''}`}>
          {formatDate(transaction.transactionDate)}
          {staleReason && (
            <span
              data-testid="stale-reconciliation-chip"
              data-stale={staleReason}
              className="inline-flex items-center rounded-full bg-amber-200 dark:bg-amber-800 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:text-amber-100"
              title={
                staleReason === 'missed'
                  ? tr('stale.missedTooltip')
                  : tr('stale.overdueTooltip')
              }
            >
              {staleReason === 'missed' ? tr('stale.missedChip') : tr('stale.overdueChip')}
            </span>
          )}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''} hidden lg:table-cell`}>
        {transaction.account?.name || '-'}
      </td>
      <td className={`${cellPadding} max-w-[100px] sm:max-w-none overflow-hidden`}>
        <div className="flex items-center gap-2 min-w-0">
          {/* Brand badge beside the name, never inside the button: the button's
              text is the payee name, and a decorative glyph in it changes what
              every textContent assertion reads. Hidden at dense, where the row
              is one line of data and a 20px chip per row is noise. */}
          {density !== 'dense' && payeeLabel && (
            <PayeeLogo
              payee={transaction.payee}
              name={payeeLabel}
              size={20}
              className="hidden sm:inline-flex"
            />
          )}
          {transaction.payeeId && onPayeeClick ? (
            <button
              onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
              className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate sm:max-w-[280px] text-left ${isVoid ? 'line-through' : ''}`}
              title={t('list.row.viewPayeeTitle', { name: payeeLabel ?? '' })}
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
        </div>
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
            {transaction.category && (
              <CategoryPill
                name={transaction.category.name}
                color={categoryColor}
                icon={categoryIcon}
                density={density}
                maxWidthClass="max-w-[140px]"
                title={
                  onCategoryClick
                    ? t('list.row.filterByCategory', { name: transaction.category.name })
                    : undefined
                }
                onClick={
                  onCategoryClick
                    ? (e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }
                    : undefined
                }
              />
            )}
            {onTransferClick && transaction.linkedTransaction?.account?.id && transaction.linkedTransactionId ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTransferClick(transaction.linkedTransaction!.account!.id, transaction.linkedTransactionId!);
                }}
                className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                title={`Click to view in ${transaction.linkedTransaction.account.name}`}
              >
                {transferDirection(transaction.amount) === 'to'
                  ? `\u2192 ${transaction.linkedTransaction.account.name}`
                  : `${transaction.linkedTransaction.account.name} \u2192`}
              </button>
            ) : (
              <span
                className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                title={transaction.linkedTransaction?.account?.name
                  ? t('list.row.transferTitle', { direction: transferDirection(transaction.amount), name: transaction.linkedTransaction.account.name })
                  : t('list.row.transfer')}
              >
                {transaction.linkedTransaction?.account?.name
                  ? (transferDirection(transaction.amount) === 'to'
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
                        {transferDirection(split.amount) === 'to'
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

            return (
              <span className="inline-flex items-center">
                <CategoryPill
                  name={transaction.category!.name}
                  color={categoryColor}
                  icon={categoryIcon}
                  density={density}
                  title={
                    onCategoryClick
                      ? t('list.row.filterByCategory', { name: transaction.category!.name })
                      : undefined
                  }
                  onClick={
                    onCategoryClick
                      ? (e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }
                      : undefined
                  }
                />
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
      <td className={`${cellPadding} whitespace-nowrap text-center text-sm hidden min-[900px]:table-cell`}>
        {transaction.attachmentCount && transaction.attachmentCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300" title={t('list.attachmentsCount', { count: transaction.attachmentCount })}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            {transaction.attachmentCount}
          </span>
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
        {!showFxColumns &&
          transaction.originalCurrencyCode &&
          transaction.originalAmount !== null && (
            <div className="text-xs font-normal text-gray-500 dark:text-gray-400">
              {transaction.originalCurrencyCode}{' '}
              {formatAmountWithCommas(
                Math.abs(Number(transaction.originalAmount)),
                getDecimalPlacesForCurrency(transaction.originalCurrencyCode),
              )}
            </div>
          )}
      </td>
      {showFxColumns && (
        <>
          <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
            {transaction.originalCurrencyCode || '-'}
          </td>
          <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
            {transaction.originalCurrencyCode && transaction.originalAmount !== null
              ? formatAmount(
                  Number(transaction.originalAmount),
                  transaction.originalCurrencyCode,
                )
              : '-'}
          </td>
          <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
            {fxFeePaid !== 0 ? (
              <span className={fxFeePaid > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>
                {formatCurrency(fxFeePaid, transaction.currencyCode)}
              </span>
            ) : (
              <span className="text-gray-400 dark:text-gray-500">-</span>
            )}
          </td>
        </>
      )}
      {showRunningBalance && (
        <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
          {runningBalance !== undefined
            ? formatBalance(runningBalance, transaction.currencyCode)
            : '-'}
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-center hidden min-[1400px]:table-cell`}>
        <StatusCellButton
          status={transaction.status}
          dense={density === 'dense'}
          onCycle={() => onCycleStatus(transaction)}
        />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2 hidden min-[480px]:table-cell sticky right-0 ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
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
        {!transaction.linkedInvestmentTransactionId && !hideDelete && (
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
