'use client';

import { useState, memo, type JSX, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLocalizedAmount } from '@/hooks/useLocalizedAmount';
import { getDecimalPlacesForCurrency } from '@/lib/format';
import {
  overrideEffectiveAmount,
  scheduleEffectiveAmount,
} from '@/lib/scheduled-effective-amount';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import {
  HIGHLIGHT_FLASH,
  HIGHLIGHT_FLASH_CELL,
  useScrollIntoViewWhen,
} from '@/hooks/useHighlightTarget';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel } from '@/components/ui/Table';
import {
  buildScheduledActions,
  runScheduledAction,
  scheduledConfirmConfig,
  ScheduledEmptyState,
  useDueDateStatus,
  useScheduledAmountFormatter,
  type ConfirmAction,
  type ConfirmState,
  type DueDateStatus,
} from '@/components/scheduled-transactions/ScheduledTransactionListParts';

/**
 * Cash impact of a scheduled transaction occurrence, taking nextOverride into
 * account when `useOverride` is true. This is the server's effective amount --
 * what the occurrence would post *today* -- not the persisted `amount` and not a
 * locally recomputed one (issue #1247). A scheduled investment's stored `amount`
 * is its security-currency cash impact, converted at the *current* settlement
 * rate; recomputing the pre-FX figure here (which this list used to do) showed a
 * number in one currency under another currency's code, and disagreed with both
 * the cash-flow forecast and the posting. `null` means the amount is unknown.
 */
function scheduledOccurrenceAmount(
  transaction: ScheduledTransaction,
  useOverride: boolean,
): number | null {
  const override = useOverride ? transaction.nextOverride : null;
  return override
    ? overrideEffectiveAmount(transaction, override).amount
    : scheduleEffectiveAmount(transaction).amount;
}

/**
 * What the Category column shows, in BOTH of this row's layouts: a five-way
 * decision -- an investment chip naming the action and the security, a transfer
 * chip, a split chip counting its lines, the category's own colour-mixed pill,
 * or the muted em dash for a row with no category at all -- so it lives in one
 * place rather than being re-decided by a layout mode. It stays in THIS file
 * rather than beside the other shared pieces because these chips spell the
 * recorded pill fingerprint, and that baseline is keyed per file.
 *
 * `bounded` is the one thing a caller may vary, and it is layout, not meaning:
 * the tier cell has a column to sit in, while the card's chip shares a grid
 * track with a caption, so there it takes `max-w-full` and truncates its label
 * inside the chip the way `CategoryPill` does -- `title` included, since a
 * label a track cut has to stay recoverable.
 */
function ScheduledCategoryMarker({
  transaction,
  badgePadding,
  categoryColor,
  bounded = false,
}: {
  transaction: ScheduledTransaction;
  badgePadding: string;
  categoryColor: string | null;
  bounded?: boolean;
}) {
  const cap = bounded ? ' max-w-full' : '';
  const bound = (n: ReactNode) => (bounded ? <span className="truncate">{n}</span> : n);
  return transaction.isInvestment ? (
    <span
      className={`inline-flex text-xs font-medium rounded-full ${badgePadding}${cap} bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200`}
      title={
        transaction.investmentSecurity
          ? `${transaction.investmentAction || ''} ${transaction.investmentSecurity.symbol || transaction.investmentSecurity.name}`.trim()
          : transaction.investmentAction || 'Investment'
      }
    >
      {bound(transaction.investmentSecurity?.symbol
        ? `${transaction.investmentAction || 'Investment'}: ${transaction.investmentSecurity.symbol}`
        : transaction.investmentAction || 'Investment')}
    </span>
  ) : transaction.isTransfer ? (
    <span
      className={`inline-flex text-xs font-medium rounded-full ${badgePadding}${cap} bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200`}
      title={`Transfer to ${transaction.transferAccount?.name || 'account'}`}
    >
      {bound('Transfer')}
    </span>
  ) : transaction.isSplit ? (
    <span
      className={`inline-flex text-xs font-medium rounded-full ${badgePadding}${cap} bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200`}
      title={transaction.splits?.map(s => s.category?.name || 'Uncategorized').join(', ')}
    >
      {bound(<>Split ({transaction.splits?.length || 0})</>)}
    </span>
  ) : transaction.category ? (
    <span
      className={`inline-flex text-xs font-medium rounded-full ${badgePadding}${cap}`}
      // Only where the label can be cut: `CategoryPill` pairs its inner
      // `truncate` with a `title`, and copying the truncation without the
      // recovery leaves the one surface that shows a category unable to
      // read it. The tier chip is uncut, so it keeps no attribute at all.
      title={bounded ? transaction.category.name : undefined}
      style={{
        backgroundColor: categoryColor
          ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
          : 'var(--category-bg-base, #e5e7eb)',
        color: categoryColor
          ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
          : 'var(--category-text-base, #6b7280)',
      }}
    >
      {bound(transaction.category.name)}
    </span>
  ) : (
    <span className="text-xs text-gray-400 dark:text-gray-500">{'\u2014'}</span>
  );
}

/**
 * What the Auto column shows, in BOTH layouts: the auto-post chip, or the muted
 * em dash for a schedule the user posts by hand -- a decision, not a label, so a
 * layout mode never re-makes it. It is a READ-ONLY marker of `autoPost`, never a
 * toggle: the flag is set on the schedule's own form.
 */
function ScheduledAutoMarker({
  transaction,
  badgePadding,
}: {
  transaction: ScheduledTransaction;
  badgePadding: string;
}) {
  const t = useTranslations('scheduledTransactions');
  return transaction.autoPost ? (
    <span
      className={`inline-flex items-center text-xs font-medium rounded-full ${badgePadding} bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200`}
      title={t('list.autoPostTitle')}
    >
      {t('list.autoPostBadge')}
    </span>
  ) : (
    <span className="text-xs text-gray-400 dark:text-gray-500">{'\u2014'}</span>
  );
}

/**
 * What the Schedule column shows, in BOTH layouts: the next due date (with the
 * slot's own date struck through when an override moved the occurrence), then
 * the frequency, the occurrences remaining and the "N modified" chip.
 *
 * `dueDateStatus` is passed rather than derived so the CARD can pass `null`:
 * there the overdue chip sits beside the name on line 1, exactly where the tier
 * row's own phone sub-line puts it, and drawing it here too would print it
 * twice on one card.
 */
function ScheduledScheduleDetails({
  transaction,
  formatDate,
  dueDateStatus,
  stackedLines,
}: {
  transaction: ScheduledTransaction;
  formatDate: (date: string) => string;
  dueDateStatus: DueDateStatus | null;
  stackedLines: string;
}) {
  const t = useTranslations('scheduledTransactions');
  return (
    <div className={stackedLines}>
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
    </div>
  );
}

/**
 * The Amount column's figure, in BOTH layouts: the occurrence's EFFECTIVE
 * amount and its settlement currency -- what it would post today -- never the
 * persisted snapshot (issue #1247). Nothing here is re-decided by a layout
 * mode: the struck-through base beside an overridden amount, the foreign-
 * currency line under a converted estimate and the muted placeholder a null
 * amount falls to are one implementation, called twice.
 */
function ScheduledAmountValue({
  transaction,
  formatAmount,
}: {
  transaction: ScheduledTransaction;
  formatAmount: (amount: number | null | undefined, currencyCode?: string) => JSX.Element;
}) {
  const t = useTranslations('scheduledTransactions');
  const formatAmountLocal = useLocalizedAmount();
  const baseAmount = scheduledOccurrenceAmount(transaction, false);
  // The currency the effective amount is expressed in -- the settlement
  // account's for an investment schedule, not the brokerage's `currencyCode`
  // (issue #1247).
  const amountCurrency = scheduleEffectiveAmount(transaction).currencyCode;
  const overrideAmount = transaction.nextOverride
    ? scheduledOccurrenceAmount(transaction, true)
    : null;
  const isModified =
    overrideAmount != null &&
    baseAmount != null &&
    Number(overrideAmount) !== Number(baseAmount);
  // A foreign-currency schedule shows the fixed amount the biller charges
  // under the converted estimate, as a foreign-entered transaction row does.
  const foreignLine =
    transaction.originalCurrencyCode && transaction.originalAmount != null ? (
      <div
        className="text-xs font-normal text-gray-500 dark:text-gray-400"
        title={t('list.foreignAmountTitle')}
      >
        {transaction.originalCurrencyCode}{' '}
        {formatAmountLocal(
          Math.abs(Number(transaction.originalAmount)),
          getDecimalPlacesForCurrency(transaction.originalCurrencyCode),
        )}
      </div>
    ) : null;
  if (isModified) {
    return (
      <div className="flex flex-col items-end">
        <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
          {formatAmount(baseAmount, amountCurrency)}
        </span>
        <span title={t('list.modifiedAmountTitle')}>
          {formatAmount(overrideAmount, amountCurrency)}
        </span>
        {foreignLine}
      </div>
    );
  }
  return (
    <>
      {formatAmount(baseAmount, amountCurrency)}
      {foreignLine}
    </>
  );
}

interface ScheduledTransactionRowProps {
  transaction: ScheduledTransaction;
  isProcessing: boolean;
  density: DensityLevel;
  cellPadding: string;
  /** Row position, for the striping that carries a row across a dense table. */
  index: number;
  formatDate: (date: string) => string;
  formatAmount: (amount: number | null | undefined, currencyCode?: string) => JSX.Element;
  getDueDateStatus: (nextDueDate: string | undefined | null) => DueDateStatus | null;
  getRowHandlers: (transaction: ScheduledTransaction) => LongPressRowHandlers;
  onPost?: (transaction: ScheduledTransaction) => void;
  onOpenConfirm: (action: 'post' | 'skip' | 'delete', transaction: ScheduledTransaction) => void;
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
  categoryColorMap?: Map<string, string | null>;
  isHighlighted?: boolean;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and density renders
   * the tier row below, unchanged.
   *
   * The card carries SIX of this table's seven columns: Name / Payee, Amount,
   * Schedule, Account, Category and Auto. FOUR of them a phone-width tier row
   * does not show at all -- Account and Schedule are `hidden sm:table-cell`,
   * Category and Auto `hidden md:table-cell` -- so the card is how they get
   * back on screen; Name / Payee and Amount are the two a phone already shows.
   *
   * ONE column is left out: **Actions**, because the long-press (and
   * right-click) sheet these same row handlers open already carries all five of
   * its verbs. Nothing else is dropped -- everything hanging under a cell rides
   * along: the payee sub-line, the struck-through original date of a moved
   * occurrence, the occurrences-remaining count, the "N modified" chip, the
   * struck-through base beside an overridden amount and the foreign-currency
   * line under a converted estimate. The tier's own `sm:hidden` sub-line is not
   * an omission either -- it restates the due date and frequency that line 2
   * carries captioned and in full, and its overdue chip survives on line 1
   * beside the name, where that sub-line puts it.
   *
   * The three lines are: Name (with the payee sub-line and the due-status chip)
   * and Amount; Schedule and Account; Category and Auto.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell is
   * `min-[480px]` and `wrapped` covers everything below 640px, so between 480px
   * and 639px at Normal density the actions move from inline buttons to that
   * sheet -- and stop being tab-reachable there. It is the price of the card,
   * paid for the four columns above; the register, accounts, payees and
   * securities lists make the same trade at the same two widths, and Compact
   * density is the way back to inline actions.
   */
  wrapped?: boolean;
}

const ScheduledTransactionRow = memo(function ScheduledTransactionRow({
  transaction,
  isProcessing,
  density,
  cellPadding,
  index,
  formatDate,
  formatAmount,
  getDueDateStatus,
  getRowHandlers,
  onPost,
  onOpenConfirm,
  onEdit,
  onEditOccurrence,
  categoryColorMap,
  isHighlighted,
  wrapped = false,
}: ScheduledTransactionRowProps) {
  const rowRef = useScrollIntoViewWhen<HTMLTableRowElement>(!!isHighlighted);
  const t = useTranslations('scheduledTransactions');
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;
  const effectiveDueDate = transaction.nextOverride?.overrideDate || transaction.nextDueDate || '';
  const dueDateStatus = effectiveDueDate ? getDueDateStatus(effectiveDueDate) : null;
  const payee = transaction.payeeName || transaction.payee?.name;
  const isOverdue = dueDateStatus?.label === t('list.dueDateStatus.overdue');
  // One expression, used by the row and by the sticky actions cell that has to
  // sit on the same ground as the row it belongs to.
  const rowBackground = isOverdue
    ? 'bg-red-50 dark:bg-red-900/10'
    : density !== 'normal' && index % 2 === 1
      ? 'bg-gray-50 dark:bg-table-stripe-dark'
      : 'bg-white dark:bg-gray-900';
  const badgePadding = density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-0.5';
  // At dense a row is one line: the secondary line each of these cells carries
  // sits beside its primary rather than under it. Nothing is dropped -- the
  // payee, the frequency and the occurrence count are all still on screen.
  const stackedLines = density === 'dense' ? 'flex items-baseline gap-1.5 flex-wrap' : '';

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a different
  // set of facts -- the amount, the schedule details, the category chip and the
  // auto-post marker are the same components the tier renders, so the two cannot
  // disagree about what an occurrence costs, when it falls due or what an absent
  // category looks like. Nothing in the card is interactive (the row's handlers
  // own the click and the long press, and the tier's only control, the Actions
  // cell, is the column the card drops), so nothing here needs `stopPropagation`.
  if (wrapped) {
    return (
      <tr
        ref={rowRef}
        className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${!transaction.isActive ? 'opacity-50' : ''} ${rowBackground} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
        {...getRowHandlers(transaction)}
      >
        <td className="p-0">
          {/* The inset is the density table's, not a hand-picked one. */}
          <div className={cellPadding}>
            {/* A grid, not a flex row, and `minmax(0,1fr)` rather than a plain
                `1fr`: a track that may be zero lets the name and the account
                shrink, where a flex item's `min-w-0` still contributes its
                nowrap text's full width to the table's minimum -- and on a phone
                that is not merely a scrollbar, since mobile Chrome sizes the
                `position: fixed` viewport from the page's widest content. */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start">
              {/* Line 1, left: the row's identity. The tier cell lets the name
                  WRAP, so `truncate` would cut it to one line; `line-clamp-2`
                  keeps two, and a wrapping box adds no minimum width, so
                  containment is identical to `truncate`. What that costs: a name
                  past two lines IS shortened here where the tier wrapped it
                  whole, recoverable through `title` for a pointer and for
                  assistive technology but not for a tap. Two lines is the bound
                  the register, securities and payees cards use -- unclamped, one
                  name pushes the amount and the schedule down a screen.
                  `flex-wrap` then keeps the name the IDENTITY of the card: it is
                  the only shrinkable item here, while the overdue chip cannot
                  shrink below its own words ("Yakında Vadesi Doluyor" in `tr`)
                  and would otherwise take its width out of the name's. Wrapping
                  drops the chip to its own line instead; a short name keeps it
                  inline. The chip describes itself, so no caption. */}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div
                    className="min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2"
                    title={transaction.name}
                  >
                    {transaction.name}
                  </div>
                  {dueDateStatus && (
                    <span className={`inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 ${dueDateStatus.className}`}>
                      {dueDateStatus.label}
                    </span>
                  )}
                </div>
                {payee && payee !== transaction.name && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2" title={payee}>
                    {payee}
                  </div>
                )}
              </div>
              {/* Line 1, right: the key figure, under the header label the card
                  dropped. The caption is its own node above the value's, so a
                  test still matches the amount alone. `whitespace-nowrap` goes
                  on the VALUE, never the wrapper: this is an `auto` track whose
                  minimum is its item's min-content, so a nowrap wrapper would
                  size it from whichever is wider, the figure or the CAPTION. The
                  figure must not wrap (a locale grouping thousands with a thin
                  space breaks it in two) and is never truncated. */}
              <div className="text-right">
                <CellLabel>{t('list.columns.amount')}</CellLabel>
                <div className="text-sm font-medium whitespace-nowrap">
                  <ScheduledAmountValue transaction={transaction} formatAmount={formatAmount} />
                </div>
              </div>
              {/* Line 2: two EQUAL zero-minimum tracks (`grid-cols-2` is
                  `repeat(2, minmax(0,1fr))`), never an `auto` beside a `1fr`.
                  An `auto` track takes its item's MAX-content when there is any
                  room, so a captioned value in one starves the `1fr` beside it
                  -- and a caption is a locale-sized width input
                  ("Pianificazione" in `it`), while the frequency runs to
                  "Toutes les 4 semaines" in `fr`. Equal tracks let a long
                  caption buy a second line of height instead of the column
                  beside it. The schedule slot's values are deliberately NOT
                  nowrap: it holds a sentence-like frequency line, and a wrapped
                  date is untidy where a wrapped money figure is unreadable. The
                  account NAME is the one thing here that may truncate. */}
              <div className="col-span-2 grid grid-cols-2 items-start gap-x-4">
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.schedule')}</CellLabel>
                  <ScheduledScheduleDetails
                    transaction={transaction}
                    formatDate={formatDate}
                    dueDateStatus={null}
                    stackedLines=""
                  />
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.account')}</CellLabel>
                  <div
                    className="text-sm text-gray-900 dark:text-gray-100 truncate"
                    title={transaction.account?.name}
                  >
                    {transaction.account?.name}
                  </div>
                </div>
              </div>
              {/* Line 3: the category chip in a zero-minimum track, the
                  auto-post marker in an `auto` one. `auto` is safe for the
                  second slot alone because BOTH its caption and its value are
                  bounded and short in every locale (longest caption "Otomatis",
                  longest chip "Увімк."), while the chip beside it carries a
                  category name of any length -- and a chip does not shrink
                  inside a squeezed track, it overflows into its neighbour, so
                  here it takes `max-w-full` and truncates.

                  Both slots are captioned even though a chip normally describes
                  itself, because each has a branch that does not: a schedule
                  with no category and one that does not auto-post both render a
                  bare em dash, which uncaptioned says nothing about what it is
                  of -- the job the column header used to do. The caption sits on
                  the slot rather than the dash branch, so the line keeps its
                  shape row to row. */}
              <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.category')}</CellLabel>
                  <ScheduledCategoryMarker
                    transaction={transaction}
                    badgePadding={badgePadding}
                    categoryColor={categoryColor}
                    bounded
                  />
                </div>
                <div className="text-right">
                  <CellLabel>{t('list.columns.auto')}</CellLabel>
                  <ScheduledAutoMarker transaction={transaction} badgePadding={badgePadding} />
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  // Built below the card branch, not above it: the row actions are consumed by
  // the tier `RowActions` cell alone -- the card sends them to the long-press
  // sheet the list mounts -- so building them for a wrapped row would be five
  // objects and five catalog lookups per row, per render, on the one surface
  // that never uses them (the same reason `SecurityList` builds them here).
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

  return (
    <tr
      ref={rowRef}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${!transaction.isActive ? 'opacity-50' : ''} ${rowBackground} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      {...getRowHandlers(transaction)}
    >
      {/* Name / Payee */}
      <td className={cellPadding}>
        <div className={stackedLines}>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{transaction.name}</div>
          {payee && payee !== transaction.name && (
            <div className="text-xs text-gray-500 dark:text-gray-400">{payee}</div>
          )}
        </div>
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
      <td className={`${cellPadding} hidden sm:table-cell`}>
        <div className="text-sm text-gray-900 dark:text-gray-100">{transaction.account?.name}</div>
      </td>

      {/* Category */}
      <td className={`${cellPadding} hidden md:table-cell`}>
        <ScheduledCategoryMarker
          transaction={transaction}
          badgePadding={badgePadding}
          categoryColor={categoryColor}
        />
      </td>

      {/* Amount */}
      <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
        <ScheduledAmountValue transaction={transaction} formatAmount={formatAmount} />
      </td>

      {/* Schedule (Frequency + Next Due + Remaining) */}
      <td className={`${cellPadding} hidden sm:table-cell`}>
        <ScheduledScheduleDetails
          transaction={transaction}
          formatDate={formatDate}
          dueDateStatus={dueDateStatus}
          stackedLines={stackedLines}
        />
      </td>

      {/* Auto-post */}
      <td className={`${cellPadding} text-center hidden md:table-cell`}>
        <ScheduledAutoMarker transaction={transaction} badgePadding={badgePadding} />
      </td>

      {/* Actions */}
      <td className={`${cellPadding} whitespace-nowrap text-right hidden min-[480px]:table-cell sticky right-0 ${rowBackground} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Icon-only from `compact` up: five verbs as text labels would widen
            the cell past the data it sits beside. Dense still tightens them. */}
        <RowActions actions={actions} density={density === 'dense' ? 'dense' : 'compact'} />
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
  /** Scheduled-transaction id to flash/scroll to (deep-link target). */
  highlightId?: string | null;
}

export function ScheduledTransactionList({
  transactions,
  onEdit,
  onEditOccurrence,
  onPost,
  onRefresh,
  categoryColorMap,
  highlightId,
}: ScheduledTransactionListProps) {
  const t = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  const formatAmount = useScheduledAmountFormatter();
  const getDueDateStatus = useDueDateStatus();
  const { density } = useDensityPreference('bills');
  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each schedule is a wrapped card carrying the Account and
  // Schedule this table hides below `sm` and the Category and Auto it hides
  // below `md`; Compact and Dense keep the tier table, unchanged, as does every
  // non-phone width. Exactly one branch renders per row, chosen here. This list
  // has one mounting surface (`app/bills/page.tsx`), so there is no caller
  // whose columns the card cannot carry to exclude from wrapping.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';
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
      // A failed action refreshes nothing: a refetch claims the ledger moved.
      if (await runScheduledAction(action, transaction.id, t)) {
        onRefresh?.();
      }
    } finally {
      setActionInProgress(null);
    }
  };

  if (transactions.length === 0) {
    return <ScheduledEmptyState />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        {/* On a phone at Normal density the card labels its own values, so the
            column header is dropped outright rather than replaced by a slim
            one. This header holds NOTHING interactive: these `<th>`s are plain
            labels, the list has no sort control and no `SortField` of its own
            (the Bills page owns ordering and filtering), and the density toggle
            lives on the page above -- so a slim header would have no control to
            carry, and a column label over one cell holding every column at once
            would misdescribe it to a screen reader. */}
        {!wrapped && (
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
              {t('list.columns.namePayee')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
              {t('list.columns.account')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
              {t('list.columns.category')}
            </th>
            <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
              {t('list.columns.amount')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
              {t('list.columns.schedule')}
            </th>
            <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
              {t('list.columns.auto')}
            </th>
            <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
              {t('list.columns.actions')}
            </th>
          </tr>
        </thead>
        )}
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {transactions.map((transaction, index) => (
            <ScheduledTransactionRow
              key={transaction.id}
              transaction={transaction}
              isProcessing={actionInProgress === transaction.id}
              density={density}
              cellPadding={cellPadding}
              index={index}
              formatDate={formatDate}
              formatAmount={formatAmount}
              getDueDateStatus={getDueDateStatus}
              getRowHandlers={getRowHandlers}
              onPost={onPost}
              onOpenConfirm={openConfirm}
              onEdit={onEdit}
              onEditOccurrence={onEditOccurrence}
              categoryColorMap={categoryColorMap}
              isHighlighted={!!highlightId && transaction.id === highlightId}
              wrapped={wrapped}
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
        {...scheduledConfirmConfig(confirmState.action, confirmState.transaction, t)}
      />
    </div>
  );
}
