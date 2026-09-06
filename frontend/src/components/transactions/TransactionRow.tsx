'use client';

import { memo, useState, useRef, useEffect, useCallback, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { getIconComponent } from '@/components/ui/IconPicker';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { registerDateColumnPadding } from '@/components/transactions/register-date-columns';
import {
  registerColumnClass,
  REGISTER_DESCRIPTION_CELL_FLEX,
  REGISTER_PAYEE_CELL_FLOOR,
  REGISTER_PAYEE_NAME_CAP,
} from '@/components/transactions/register-columns';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { Transaction, TransactionSplit, TransactionStatus } from '@/types/transaction';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { CategoryBudgetStatus } from '@/types/budget';
import { DensityLevel } from '@/hooks/useTableDensity';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL } from '@/hooks/useHighlightTarget';
import { getDecimalPlacesForCurrency } from '@/lib/format';
import { foreignTransactionFee } from '@/lib/fx-fees';
import { transferDirection } from '@/lib/transfer-label';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useLocalizedAmount } from '@/hooks/useLocalizedAmount';
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
  /**
   * Render the row as a wrapped two-line card instead of the tier table's
   * cells. The list sets it for phones at Normal density only (Model B: on a
   * phone the density toggle picks the layout); every other width and level
   * renders the tier row below, unchanged.
   */
  wrapped?: boolean;
  showRunningBalance?: boolean;
  runningBalance: number | undefined;
  /** When set, a filter has reduced which splits are visible.  Show this
   *  amount instead of the full transaction amount and flag as partial. */
  displayAmount?: number;
  isDeleting: boolean;
  formatDate: (date: string) => string;
  /**
   * Drop the year from the Date column, at every width. On phones this hands
   * the freed width to the payee; on wider screens it is simply the user's
   * chosen date view. The long-press action sheet still shows the full date,
   * so the year stays reachable.
   */
  compactDates?: boolean;
  /** Day and month in the user's own ordering (useDateFormat's formatDateWithoutYear). */
  formatCompactDate?: (date: string) => string;
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
  wrapped = false,
  showRunningBalance = isSingleAccountView,
  runningBalance,
  displayAmount,
  isDeleting,
  formatDate,
  compactDates,
  formatCompactDate,
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
  const compactPadding = registerDateColumnPadding(compactDates);
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  // The reconciliation chips live in the reconcile catalog so the register and
  // the reconcile table say the same thing about the same row.
  const tr = useTranslations('reconcile');
  const { formatCurrency, formatPercent } = useNumberFormat();
  // Read-only amounts, grouped in the user's number locale (en-US unchanged).
  const formatAmountLocal = useLocalizedAmount();
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

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- every value below is the same value the tier
  // branch renders, from the same helper. Edit/Copy/Delete are deliberately
  // absent: on a phone those live in the long-press action sheet the same
  // handlers below open. Description, Ref #, attachments and the three FX
  // columns are left out to keep the card to two lines -- three when the row
  // carries tags, which take a line of their own under the category.
  if (wrapped) {
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
        className={`group ${HOVER_ROW_ON_PAGE} select-none touch-manipulation bg-white dark:bg-gray-900 ${isVoid ? 'opacity-50' : ''} ${isFuture && !isVoid ? 'opacity-60' : ''} ${onEdit ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      >
        <td className="p-0">
          <div className="px-4 py-3 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start">
            <div className="flex items-center gap-2">
              {selectionMode && (
                <span onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected || false}
                    onChange={() => onToggleSelection?.()}
                    className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
                  />
                </span>
              )}
              <span
                className={`flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}
              >
                {compactDates && formatCompactDate ? (
                  <span title={formatDate(transaction.transactionDate)}>
                    {formatCompactDate(transaction.transactionDate)}
                  </span>
                ) : (
                  formatDate(transaction.transactionDate)
                )}
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
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                {/* The card has room for the brand badge at every phone width,
                    so unlike the tier cell it is not dropped here. */}
                {payeeLabel && (
                  <PayeeLogo payee={transaction.payee} name={payeeLabel} size={20} />
                )}
                {transaction.payeeId && onPayeeClick ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
                    className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate text-left ${isVoid ? 'line-through' : ''}`}
                    title={t('list.row.viewPayeeTitle', { name: payeeLabel ?? '' })}
                  >
                    {payeeLabel || '-'}
                  </button>
                ) : (
                  <div
                    className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate ${isVoid ? 'line-through' : ''}`}
                    title={payeeLabel || undefined}
                  >
                    {payeeLabel || '-'}
                  </div>
                )}
              </div>
            </div>
            <div
              className={`text-right whitespace-nowrap text-sm font-medium ${isVoid ? 'line-through' : ''}`}
            >
              {displayAmount !== undefined ? (
                <span
                  title={t('list.row.filteredAmountTitle', { amount: formatAmountLocal(Math.abs(transaction.amount), getDecimalPlacesForCurrency(transaction.currencyCode)) })}
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
                    {formatAmountLocal(
                      Math.abs(Number(transaction.originalAmount)),
                      getDecimalPlacesForCurrency(transaction.originalCurrencyCode),
                    )}
                  </div>
                )}
            </div>
            <div className="col-span-3 flex flex-wrap items-center gap-1.5">
              {/* Structural, not responsive, exactly as in the tier row: a
                  single-account page never repeats its own title. */}
              {!isSingleAccountView && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {transaction.account?.name || '-'}
                </span>
              )}
              {transaction.linkedInvestmentTransactionId ? (
                // No `title` here, unlike the tier cell: a hover tooltip is
                // unreachable on a phone, and the pill's own label already
                // says what it says.
                <span className="inline-flex text-xs leading-5 font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 px-2 py-1">
                  {t('list.row.investmentLabel')}
                </span>
              ) : transaction.isTransfer ? (
                <>
                  {transaction.category && (
                    <CategoryPill
                      name={transaction.category.name}
                      color={categoryColor}
                      icon={categoryIcon}
                      density={density}
                      maxWidthClass="max-w-[160px]"
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
                      className="inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors px-2 py-1"
                      title={t('list.row.transferTitle', { direction: transferDirection(transaction.amount), name: transaction.linkedTransaction.account.name })}
                    >
                      {transferDirection(transaction.amount) === 'to'
                        ? `\u2192 ${transaction.linkedTransaction.account.name}`
                        : `${transaction.linkedTransaction.account.name} \u2192`}
                    </button>
                  ) : (
                    <span
                      className="inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] px-2 py-1"
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
                </>
              ) : transaction.isSplit ? (
                <span className="inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 px-2 py-1">
                  {t('list.row.split')}{transaction.splits ? ` (${transaction.splits.length})` : ''}
                </span>
              ) : transaction.category ? (
                <CategoryPill
                  name={transaction.category.name}
                  color={categoryColor}
                  icon={categoryIcon}
                  density={density}
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
              ) : null}
              <span className="ml-auto flex items-center gap-2">
                {/* StatusCellButton stops the click itself, so it needs no
                    wrapper here -- the tier branch mounts it bare too. */}
                <StatusCellButton
                  status={transaction.status}
                  dense={false}
                  onCycle={() => onCycleStatus(transaction)}
                />
                {showRunningBalance && (
                  <span className="text-right whitespace-nowrap text-sm font-medium">
                    <span className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 leading-tight">
                      {t('list.header.balance')}
                    </span>
                    {runningBalance !== undefined
                      ? formatBalance(runningBalance, transaction.currencyCode)
                      : '-'}
                  </span>
                )}
              </span>
            </div>
            {/* Line 3, only when the row carries tags: under the category
                rather than beside it. Inline after the category, one tag was
                enough to push the status and balance onto a line of their
                own, so the card grew a line anyway -- with the pills and the
                figures interleaved. On their own line the tags wrap among
                themselves and line 2 keeps its shape. */}
            {transaction.tags && transaction.tags.length > 0 && (
              <div className="col-span-3 flex flex-wrap items-center gap-1.5">
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
            )}
          </div>
        </td>
      </tr>
    );
  }

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
      <td className={`${cellPadding} ${compactPadding.date} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
        <span className={`flex items-center gap-1.5 ${isVoid ? 'line-through' : ''}`}>
          {compactDates && formatCompactDate ? (
            // The full date stays reachable without leaving the row: on
            // hover here, and in the long-press action sheet.
            <span title={formatDate(transaction.transactionDate)}>
              {formatCompactDate(transaction.transactionDate)}
            </span>
          ) : (
            formatDate(transaction.transactionDate)
          )}
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
      {/* Structural, not responsive: a single-account page omits the Account
          column entirely (see register-columns.ts). */}
      {!isSingleAccountView && (
        <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''} ${registerColumnClass('account')}`}>
          {transaction.account?.name || '-'}
        </td>
      )}
      {/* Two things give the payee room when the year is hidden: this
          phone-width cap widens, and the inset between this column and the
          date closes (registerDateColumnPadding). It stays a cap, with
          truncate below, so a long payee cannot push Amount off screen.
          REGISTER_PAYEE_CELL_FLOOR is the other half: Description's w-full is
          a claim on the whole table settled against this column's content, so
          without a floor a filtered register hands Description the width the
          payee was using (see register-columns.ts). */}
      <td className={`${cellPadding} ${compactPadding.payee} ${compactDates ? 'max-w-[160px]' : 'max-w-[100px]'} sm:max-w-none ${REGISTER_PAYEE_CELL_FLOOR} overflow-hidden`}>
        <div className="flex items-center gap-2 min-w-0">
          {/* Brand badge beside the name, never inside the button: the button's
              text is the payee name, and a decorative glyph in it changes what
              every textContent assertion reads. Hidden at dense, where the row
              is one line of data and a 20px chip per row is noise, and on
              phones, where the payee column has no width to spare. */}
          {density !== 'dense' && payeeLabel && (
            <PayeeLogo
              payee={transaction.payee}
              name={payeeLabel}
              size={20}
              className="max-sm:hidden"
            />
          )}
          {transaction.payeeId && onPayeeClick ? (
            <button
              onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
              className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate ${REGISTER_PAYEE_NAME_CAP} text-left ${isVoid ? 'line-through' : ''}`}
              title={t('list.row.viewPayeeTitle', { name: payeeLabel ?? '' })}
            >
              {payeeLabel || '-'}
            </button>
          ) : (
            <div
              className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate ${REGISTER_PAYEE_NAME_CAP} ${isVoid ? 'line-through' : ''}`}
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
      <td className={`${cellPadding} ${density !== 'normal' ? 'whitespace-nowrap' : ''} ${registerColumnClass('category')}`}>
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
                          : `${split.transferAccount.name} \u2192`}: {formatAmountLocal(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}
                      </span>
                    ) : split.investmentTransaction ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {describeInvestmentSplit(split, t('list.row.uncategorized'))}: {formatAmountLocal(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}
                      </span>
                    ) : (
                      <>{split.category?.name || t('list.row.uncategorized')}: {formatAmountLocal(Math.abs(Number(split.amount)), getDecimalPlacesForCurrency(transaction.currencyCode))}</>
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
                    ? `Over budget: ${formatPercent(budgetStatus.percentUsed, 0)} used (${formatCurrency(budgetStatus.spent, transaction.currencyCode)} / ${formatCurrency(budgetStatus.budgeted, transaction.currencyCode)})`
                    : budgetStatus.percentUsed >= 80
                      ? `Approaching limit: ${formatPercent(budgetStatus.percentUsed, 0)} used (${formatCurrency(budgetStatus.remaining, transaction.currencyCode)} remaining)`
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
      {/* The column that yields: it takes whatever width the content-sized
          columns leave and shrinks first when there is none, so its arrival
          can never push Status off the visible edge of the register. */}
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 ${registerColumnClass('description')} ${REGISTER_DESCRIPTION_CELL_FLEX}`}>
        <div
          className={`truncate ${isVoid ? 'line-through' : ''}`}
          title={transaction.description || undefined}
        >
          {transaction.description || '-'}
        </div>
      </td>
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 ${registerColumnClass('refNumber')}`}>
        <div
          className={`truncate max-w-[160px] ${isVoid ? 'line-through' : ''}`}
          title={transaction.referenceNumber || undefined}
        >
          {transaction.referenceNumber || '-'}
        </div>
      </td>
      <td className={`${cellPadding} text-sm ${registerColumnClass('tags')}`}>
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
      <td className={`${cellPadding} whitespace-nowrap text-center text-sm ${registerColumnClass('attachments')}`}>
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
            title={t('list.row.filteredAmountTitle', { amount: formatAmountLocal(Math.abs(transaction.amount), getDecimalPlacesForCurrency(transaction.currencyCode)) })}
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
              {formatAmountLocal(
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
      <td className={`${cellPadding} whitespace-nowrap text-center ${registerColumnClass('status')}`}>
        <StatusCellButton
          status={transaction.status}
          dense={density === 'dense'}
          onCycle={() => onCycleStatus(transaction)}
        />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2 ${registerColumnClass('actions')} sticky right-0 ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
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
