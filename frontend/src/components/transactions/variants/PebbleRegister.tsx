'use client';

import { LinkifiedText } from '@/components/ui/LinkifiedText';
import React, { useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { HIGHLIGHT_FLASH } from '@/hooks/useHighlightTarget';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { ProvisionalAmountBadge } from '@/components/transactions/ProvisionalAmountBadge';
import { isProvisionalAmount } from '@/lib/provisional-amount';
import {
  registerGroupLabel,
  rowAmount,
  previousDay,
  type RegisterFigure,
} from '../register-style-data';

/**
 * The transactions register in the Pebble UI style: rows grouped by day in
 * white blocks, round payee avatars, large amounts, and (from `lg`) an
 * inspector for the selected row.
 *
 * A renderer only. `TransactionList` owns every handler and figure -- balances
 * from `walkRunningBalances`, day nets, delete confirmation, status cycling --
 * and this draws them. The inspector offers the actions a row already has
 * (edit, copy, schedule, delete, cycle status) and shows fields the row
 * already carries; it adds none.
 */
export interface PebbleRegisterProps {
  transactions: Transaction[];
  today: string;
  locale: string;
  todayDividerIndex: number;
  showRunningBalance: boolean;
  runningBalances: ReadonlyMap<string, number>;
  displayAmounts: ReadonlyMap<string, number>;
  /** Each day's net, in the currency it names. */
  dayNet: ReadonlyMap<string, RegisterFigure>;
  /**
   * Each day's closing balance, or null when the register has no running
   * balance. A phone's day heading prints it in place of the net, since the
   * rows' balance is not drawn below `md` (issue #2486).
   */
  dayBalance: ReadonlyMap<string, number> | null;
  inspectorVisible: boolean;
  inspectedId: string | null;
  deletingId: string | null;
  selectionMode?: boolean;
  isRowSelected: (id: string) => boolean;
  onToggleSelection?: (id: string) => void;
  highlightTransactionId?: string | null;
  onRowClick: (transaction: Transaction) => void;
  onPayeeClick?: (payeeId: string) => void;
  onLongPressStart: (transaction: Transaction, e: React.MouseEvent) => void;
  onLongPressStartTouch: (transaction: Transaction, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onContextMenu: (transaction: Transaction, e: React.MouseEvent) => void;
  onCycleStatus: (transaction: Transaction) => void;
  onEdit?: (transaction: Transaction) => void;
  onDuplicate?: (transaction: Transaction) => void;
  onScheduleRecurring?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  /** Confirm a provisional amount as it stands; offered only where `canConfirmAmount` allows. */
  onConfirmAmount?: (transaction: Transaction) => void;
  canEdit: (transaction: Transaction) => boolean;
  canDelete: (transaction: Transaction) => boolean;
  /** The reader may confirm this row's amount (they own it). Absent: never. */
  canConfirmAmount?: (transaction: Transaction) => boolean;
  categoryColorMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  /** Inherited-aware icon per category id; see buildCategoryIconMap. */
  categoryIconMap?: Map<string, string | null>;
  /** The reader's hidden columns; a hidden Description drops the memo after the payee. */
  hidden: ReadonlySet<string>;
  sortStrip: React.ReactNode;
}

/** A category's colour as a wash behind its avatar; the data's own colour, never a literal. */
function washStyle(color: string | null | undefined): React.CSSProperties | undefined {
  return color ? { backgroundColor: `${color}33` } : undefined;
}

function useCategoryLabel(
  categoryLabelMap: Map<string, string> | undefined,
) {
  const t = useTranslations('transactions');
  return (tx: Transaction): string | null => {
    if (tx.linkedInvestmentTransactionId) return t('list.row.investmentLabel');
    if (tx.isTransfer) return t('list.row.transfer');
    if (tx.isSplit) return t('list.row.split');
    if (!tx.category) return null;
    return categoryLabelMap?.get(tx.category.id) ?? tx.category.name;
  };
}

function Avatar({
  tx,
  label,
  color,
  size,
  onInk = false,
}: {
  tx: Transaction;
  label: string | null;
  color: string | null | undefined;
  size: 'md' | 'lg';
  /**
   * The avatar sits on the inspected row's inked fill. The category wash is
   * translucent, so over ink it would turn the disc as dark as the row and
   * hide the letter; a solid disc in the row's opposite tone is used instead.
   */
  onInk?: boolean;
}) {
  const dim = size === 'lg' ? 'h-13 w-13 text-xl' : 'h-9 w-9 text-sm';
  // The payee's own logo, when it has one, replaces the letter disc.
  if (tx.payee?.hasLogo) {
    return (
      <PayeeLogo
        payee={tx.payee}
        name={label}
        size={size === 'lg' ? 52 : 36}
        className="shrink-0"
      />
    );
  }
  const tone = onInk
    ? 'bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-50'
    : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100';
  return (
    <span
      aria-hidden="true"
      className={`${dim} shrink-0 rounded-full flex items-center justify-center font-bold ${tone}`}
      style={onInk ? undefined : washStyle(color)}
    >
      {tx.isTransfer ? (
        <svg width="16" height="12" viewBox="0 0 14 10" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M1 3 H12 M9 0.5 L12 3 L9 5.5 M13 7 H2 M5 4.5 L2 7 L5 9.5" />
        </svg>
      ) : (
        (label ?? '-').trim().charAt(0).toUpperCase() || '-'
      )}
    </span>
  );
}

/**
 * The avatar, made a button when the row's payee can be opened. A transfer
 * or a payee-less row has no `payeeId` and stays the plain, non-interactive
 * disc.
 */
function PayeeAvatar({
  tx,
  label,
  color,
  size,
  onInk = false,
  onPayeeClick,
}: {
  tx: Transaction;
  label: string | null;
  color: string | null | undefined;
  size: 'md' | 'lg';
  onInk?: boolean;
  onPayeeClick?: (payeeId: string) => void;
}) {
  const t = useTranslations('transactions');
  if (!tx.payeeId || !onPayeeClick) {
    return <Avatar tx={tx} label={label} color={color} size={size} onInk={onInk} />;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPayeeClick(tx.payeeId!);
      }}
      aria-label={t('list.row.viewPayeeTitle', { name: label ?? '' })}
      title={t('list.row.viewPayeeTitle', { name: label ?? '' })}
      className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <Avatar tx={tx} label={label} color={color} size={size} onInk={onInk} />
    </button>
  );
}

function amountTone(amount: number, onDark: boolean): string {
  if (amount > 0) return onDark ? 'text-green-300 dark:text-green-700' : 'text-green-700 dark:text-green-400';
  return '';
}

/**
 * One row. Memoised on primitive props and the parent's stable handlers, so
 * an inspector click re-renders the two rows whose `inspected` changed, not
 * the page. The parent resolves the label, category, colour, amount and
 * balance text, so the row subscribes to no store of its own.
 */
interface PebbleRowProps {
  tx: Transaction;
  label: string | null;
  categoryLabel: string | null;
  color: string | null | undefined;
  categoryIcon: string | null | undefined;
  amount: number;
  /** The amount shown is a display conversion, marked with an asterisk. */
  converted: boolean;
  /** The formatted running balance; null when the column is off. */
  balanceText: string | null;
  showDescription: boolean;
  selectionMode: boolean;
  selected: boolean;
  inspected: boolean;
  isFuture: boolean;
  highlighted: boolean;
  onRowClick: PebbleRegisterProps['onRowClick'];
  onPayeeClick: PebbleRegisterProps['onPayeeClick'];
  onToggleSelection: PebbleRegisterProps['onToggleSelection'];
  onLongPressStart: PebbleRegisterProps['onLongPressStart'];
  onLongPressStartTouch: PebbleRegisterProps['onLongPressStartTouch'];
  onLongPressEnd: PebbleRegisterProps['onLongPressEnd'];
  onTouchMove: PebbleRegisterProps['onTouchMove'];
  onContextMenu: PebbleRegisterProps['onContextMenu'];
  onCycleStatus: PebbleRegisterProps['onCycleStatus'];
}

const PebbleRow = React.memo(function PebbleRow({
  tx,
  label,
  categoryLabel,
  color,
  categoryIcon,
  amount,
  converted,
  balanceText,
  showDescription,
  selectionMode,
  selected,
  inspected,
  isFuture,
  highlighted,
  ...p
}: PebbleRowProps) {
  const isVoid = tx.status === TransactionStatus.VOID;
  const open = () => p.onRowClick(tx);
  return (
    <li
      data-testid="pebble-row"
      tabIndex={0}
      aria-current={inspected ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => {
        // A key on the status button is the button's, not the row's.
        if (e.target !== e.currentTarget) return;
        activateOnKey(open)(e);
      }}
      onContextMenu={(e) => p.onContextMenu(tx, e)}
      onMouseDown={(e) => p.onLongPressStart(tx, e)}
      onMouseUp={p.onLongPressEnd}
      onMouseLeave={p.onLongPressEnd}
      onTouchStart={(e) => p.onLongPressStartTouch(tx, e)}
      onTouchMove={p.onTouchMove}
      onTouchEnd={p.onLongPressEnd}
      onTouchCancel={p.onLongPressEnd}
      className={`ui-pebble-row flex items-center gap-3 sm:gap-3.5 min-h-[60px] px-3 sm:px-3.5 rounded-2xl cursor-pointer select-none touch-manipulation border-t border-gray-100 first:border-t-0 dark:border-gray-800 ${INTERACTIVE_ROW_FOCUS_CLASS} ${
        inspected
          ? 'bg-gray-900 text-gray-50 dark:bg-gray-100 dark:text-gray-900'
          : selected
            ? 'bg-blue-50 dark:bg-blue-900/20'
            : HOVER_ROW_ON_PAGE
      } ${isVoid ? 'opacity-50' : ''} ${isFuture && !isVoid ? 'opacity-60' : ''} ${highlighted ? HIGHLIGHT_FLASH : ''}`}
    >
      {selectionMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => p.onToggleSelection?.(tx.id)}
            aria-label={label ?? undefined}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus-visible:ring-blue-500 h-4 w-4 cursor-pointer"
          />
        </span>
      )}
      <PayeeAvatar tx={tx} label={label} color={color} size="md" onInk={inspected} onPayeeClick={p.onPayeeClick} />
      <span className="min-w-0 flex-1 sm:flex-[3_1_0%]">
        <span className={`block truncate font-semibold text-[15px] ${isVoid ? 'line-through' : ''}`}>
          {label || '-'}
          {tx.description && showDescription && (
            <span className={`font-normal ${inspected ? 'opacity-70' : 'text-gray-500 dark:text-gray-400'} max-sm:hidden`}>
              {' · '}<LinkifiedText text={tx.description} />
            </span>
          )}
        </span>
        {/* Phones put the category under the name, as the mockup's phone
            does, and the status beside it as the same tappable control the
            wider row has (a tap cycles it; it never opens the row). */}
        <span className={`sm:hidden flex items-center gap-1 min-w-0 text-xs ${inspected ? 'opacity-70' : 'text-gray-500 dark:text-gray-400'}`}>
          <span className="truncate">{categoryLabel}</span>
          <span className="shrink-0 -ml-1 [&>button]:text-xs [&>button]:px-2">
            <StatusCellButton status={tx.status} dense={false} onCycle={() => p.onCycleStatus(tx)} />
          </span>
        </span>
      </span>
      <span className={`hidden sm:flex items-center gap-2 min-w-0 sm:flex-[2_1_0%] text-sm ${inspected ? 'opacity-80' : 'text-gray-500 dark:text-gray-400'}`}>
        {categoryIcon && !tx.isTransfer ? (
          <CategoryGlyph icon={categoryIcon} color={color} size={16} className="shrink-0" />
        ) : (
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${tx.isTransfer ? 'border-2 border-current box-border' : 'bg-gray-400'}`}
            style={!tx.isTransfer && color ? { backgroundColor: color } : undefined}
          />
        )}
        <span className="truncate">{categoryLabel}</span>
      </span>
      <span className="hidden sm:flex shrink-0 w-24 justify-start">
        <StatusCellButton status={tx.status} dense={false} onCycle={() => p.onCycleStatus(tx)} />
      </span>
      <span className={`shrink-0 text-right font-semibold text-[15px] sm:w-28 whitespace-nowrap ${isVoid ? 'line-through' : ''} ${amountTone(amount, inspected)}`}>
        <MoneyFigure amount={amount} currencyCode={tx.currencyCode} />
        {converted && <span className="ml-0.5 text-xs font-normal">*</span>}
        <ProvisionalAmountBadge transaction={tx} onInk={inspected} />
      </span>
      {balanceText !== null && (
        <span className={`hidden md:block shrink-0 w-24 text-right text-sm ${inspected ? 'opacity-70' : 'text-gray-500 dark:text-gray-400'}`}>
          {balanceText}
        </span>
      )}
    </li>
  );
});

function InspectorRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-12 border-t border-gray-100 dark:border-gray-800">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 text-right font-semibold">{children}</dd>
    </div>
  );
}

const PILL =
  'rounded-full h-11 px-5 font-semibold bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700';

function Inspector({ tx, p }: { tx: Transaction; p: PebbleRegisterProps }) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();
  const label = payeeDisplay(tx);
  const categoryLabel = useCategoryLabel(p.categoryLabelMap)(tx);
  const color = tx.category
    ? (p.categoryColorMap?.get(tx.category.id) ?? tx.category.color)
    : null;
  const amount = rowAmount(tx, p.displayAmounts);
  const balance = p.runningBalances.get(tx.id);
  const linked = !!tx.linkedInvestmentTransactionId;
  const showEdit = !!p.onEdit && p.canEdit(tx);
  const showCopy = !linked && !!p.onDuplicate;
  const showSchedule = !linked && !!p.onScheduleRecurring;
  // A linked row's Delete removes the investment transaction it belongs to
  // (`TransactionList` routes it), so the row offers it like any other.
  const showDelete = p.canDelete(tx);
  const showConfirm =
    isProvisionalAmount(tx) && !!p.onConfirmAmount && (p.canConfirmAmount?.(tx) ?? false);
  return (
    // Sticky against the window, so it follows the list. It only sticks once
    // the page title has scrolled away, which is when the floating page bar
    // has slid in under the header, so the offset clears both: the header's
    // still-visible part (4rem less --app-header-offset as it slides away) and
    // the bar (~4rem), plus a gap. Its own height is capped to what is left,
    // scrolling inside when the details run longer. At rest its top margin
    // drops it past the sort strip and the first day's heading, so it lines
    // up with the first row's block rather than with the strip above.
    <aside
      aria-label={t('list.pebble.inspectorLabel')}
      className="ui-pebble-inspector hidden lg:flex mt-[var(--ui-pebble-first-block,0px)] lg:w-[22rem] xl:w-[24rem] shrink-0 self-start sticky top-[calc(8.5rem+env(safe-area-inset-top)-var(--app-header-offset,0px))] max-h-[calc(100dvh-9.5rem-env(safe-area-inset-top)+var(--app-header-offset,0px))] overflow-y-auto flex-col gap-4 rounded-[28px] bg-white p-7 text-gray-900 shadow-card dark:bg-gray-900 dark:text-gray-100 dark:shadow-card-dark"
    >
      <div className="flex items-center gap-3.5">
        <PayeeAvatar tx={tx} label={label} color={color} size="lg" onPayeeClick={p.onPayeeClick} />
        <div className="min-w-0">
          <div className="ui-page-title truncate text-2xl leading-tight">{label || '-'}</div>
          <div className="text-gray-500 dark:text-gray-400">
            {amount < 0 ? t('list.header.payment') : t('list.header.deposit')}
            {' · '}
            {formatDate(tx.transactionDate)}
          </div>
        </div>
      </div>
      <div className="ui-page-title ui-pebble-inspector-amount">
        <MoneyFigure amount={amount} currencyCode={tx.currencyCode} display />
        <ProvisionalAmountBadge transaction={tx} align="start" />
      </div>
      <dl className="flex flex-col">
        <InspectorRow label={t('list.header.date')}>{formatDate(tx.transactionDate)}</InspectorRow>
        {categoryLabel && <InspectorRow label={t('list.header.category')}>{categoryLabel}</InspectorRow>}
        {tx.account?.name && <InspectorRow label={t('list.header.account')}>{tx.account.name}</InspectorRow>}
        <InspectorRow label={t('list.header.status')}>
          <StatusCellButton
            status={tx.status}
            dense={false}
            onCycle={() => p.onCycleStatus(tx)}
          />
        </InspectorRow>
        {p.showRunningBalance && balance !== undefined && (
          <InspectorRow label={t('list.pebble.balanceAfter')}>
            {formatCurrency(balance, tx.currencyCode)}
          </InspectorRow>
        )}
        {tx.description && (
          <InspectorRow label={t('list.header.description')}>
            <LinkifiedText text={tx.description} />
          </InspectorRow>
        )}
        {tx.tags && tx.tags.length > 0 && (
          <InspectorRow label={t('list.header.tags')}>{tx.tags.map((tag) => tag.name).join(', ')}</InspectorRow>
        )}
        {!!tx.attachmentCount && (
          <InspectorRow label={t('list.header.attachments')}>{tx.attachmentCount}</InspectorRow>
        )}
      </dl>
      {(showEdit || showCopy || showSchedule || showDelete || showConfirm) && (
        <div className="flex flex-wrap gap-2">
          {showConfirm && (
            <button
              type="button"
              className={PILL}
              title={t('provisional.confirmActionTitle')}
              onClick={() => p.onConfirmAmount?.(tx)}
            >
              {t('provisional.confirmAction')}
            </button>
          )}
          {showEdit && (
            <button type="button" className={PILL} onClick={() => p.onEdit?.(tx)}>
              {tc('edit')}
            </button>
          )}
          {showCopy && (
            <button type="button" className={PILL} onClick={() => p.onDuplicate?.(tx)}>
              {t('row.copyOptions.copy')}
            </button>
          )}
          {showSchedule && (
            <button type="button" className={PILL} onClick={() => p.onScheduleRecurring?.(tx)}>
              {t('row.copyOptions.scheduleRecurring')}
            </button>
          )}
          {showDelete && (
            <button
              type="button"
              disabled={p.deletingId === tx.id}
              className="ml-auto rounded-full h-11 px-5 font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 disabled:opacity-50"
              onClick={() => p.onDeleteClick(tx)}
            >
              {tc('delete')}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * Publishes, as `--ui-pebble-first-block` on the register, how far below the
 * list column's top its first day block starts. The sort strip can wrap and a
 * today divider can come first, so the distance is measured, not assumed.
 */
function useFirstBlockOffset(
  registerRef: React.RefObject<HTMLDivElement | null>,
  listRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  transactions: Transaction[],
) {
  useLayoutEffect(() => {
    const register = registerRef.current;
    const list = listRef.current;
    if (!active || !register || !list) return;
    const measure = () => {
      const first = list.querySelector('ul');
      const offset = first
        ? first.getBoundingClientRect().top - list.getBoundingClientRect().top
        : 0;
      register.style.setProperty('--ui-pebble-first-block', `${Math.max(0, Math.round(offset))}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [registerRef, listRef, active, transactions]);
}

export function PebbleRegister(p: PebbleRegisterProps) {
  const t = useTranslations('transactions');
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();
  const categoryLabelOf = useCategoryLabel(p.categoryLabelMap);
  const registerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inspected =
    p.transactions.find((tx) => tx.id === p.inspectedId) ?? p.transactions[0] ?? null;

  const groupTitle = (date: string) =>
    date === p.today
      ? t('list.today')
      : date === previousDay(p.today)
        ? t('list.pebble.yesterday')
        : registerGroupLabel(date, p.locale, p.today);

  const nodes: React.ReactNode[] = [];
  const cur: { open: { date: string; rows: React.ReactNode[] } | null } = { open: null };
  const flush = () => {
    const open = cur.open;
    if (!open) return;
    const figure = p.dayNet.get(open.date);
    const net = figure?.total.value ?? 0;
    const currency =
      figure?.currency ?? p.transactions.find((x) => x.transactionDate === open.date)?.currencyCode;
    const title = groupTitle(open.date);
    const closing = p.dayBalance?.get(open.date);
    // One account's register is one currency: the balance is in the rows'.
    const closingCurrency = p.transactions.find((x) => x.transactionDate === open.date)?.currencyCode;
    nodes.push(
      <section key={open.date} aria-label={title}>
        <div className="flex items-baseline justify-between px-1.5 pt-4 pb-2">
          <h3 className="!font-sans !text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          <span
            className={`${net > 0 ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}${p.dayBalance ? ' hidden md:inline' : ''}`}
          >
            {figure ? (
              <PartialTotal total={figure.total} displayCurrency={figure.currency}>
                {net > 0 ? '+' : ''}{formatCurrency(net, currency)}
              </PartialTotal>
            ) : (
              formatCurrency(net, currency)
            )}
          </span>
          {p.dayBalance && (
            <span
              data-testid="pebble-day-balance"
              className={`md:hidden ${closing !== undefined && closing < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {closing !== undefined ? formatCurrency(closing, closingCurrency) : '-'}
            </span>
          )}
        </div>
        <ul className="rounded-2xl bg-white p-1 shadow-card dark:bg-gray-900 dark:shadow-card-dark">
          {open.rows}
        </ul>
      </section>,
    );
    cur.open = null;
  };
  p.transactions.forEach((tx, index) => {
    if (cur.open && cur.open.date !== tx.transactionDate) flush();
    if (index === p.todayDividerIndex) {
      flush();
      nodes.push(
        <div key="today-divider" className="flex items-center gap-3 px-1.5 pt-4">
          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider">
            {t('list.today')}
          </span>
          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
        </div>,
      );
    }
    if (!cur.open) cur.open = { date: tx.transactionDate, rows: [] };
    const balance = p.runningBalances.get(tx.id);
    cur.open.rows.push(
      <PebbleRow
        key={tx.id}
        tx={tx}
        label={payeeDisplay(tx)}
        categoryLabel={categoryLabelOf(tx)}
        color={tx.category ? (p.categoryColorMap?.get(tx.category.id) ?? tx.category.color) : null}
        categoryIcon={tx.category ? (p.categoryIconMap?.get(tx.category.id) ?? tx.category.icon) : null}
        amount={rowAmount(tx, p.displayAmounts)}
        converted={p.displayAmounts.has(tx.id)}
        balanceText={
          p.showRunningBalance
            ? (balance !== undefined ? formatCurrency(balance, tx.currencyCode) : '-')
            : null
        }
        showDescription={!p.hidden.has('description')}
        selectionMode={!!p.selectionMode}
        selected={p.selectionMode ? p.isRowSelected(tx.id) : false}
        inspected={p.inspectorVisible && inspected?.id === tx.id}
        isFuture={tx.transactionDate > p.today}
        highlighted={!!p.highlightTransactionId && p.highlightTransactionId === tx.id}
        onRowClick={p.onRowClick}
        onPayeeClick={p.onPayeeClick}
        onToggleSelection={p.onToggleSelection}
        onLongPressStart={p.onLongPressStart}
        onLongPressStartTouch={p.onLongPressStartTouch}
        onLongPressEnd={p.onLongPressEnd}
        onTouchMove={p.onTouchMove}
        onContextMenu={p.onContextMenu}
        onCycleStatus={p.onCycleStatus}
      />,
    );
  });
  flush();

  const showInspector = p.inspectorVisible && !!inspected;
  useFirstBlockOffset(registerRef, listRef, showInspector, p.transactions);

  return (
    <div ref={registerRef} className="ui-pebble-register flex items-start gap-6 px-4 pb-4">
      <div ref={listRef} className="min-w-0 flex-1">
        {p.sortStrip}
        {nodes}
      </div>
      {showInspector && <Inspector tx={inspected} p={p} />}
    </div>
  );
}
