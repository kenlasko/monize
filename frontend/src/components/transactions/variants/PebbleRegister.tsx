'use client';

import { LinkifiedText } from '@/components/ui/LinkifiedText';
import React from 'react';
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
import { registerGroupLabel, rowAmount, previousDay } from '../register-style-data';

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
  dayNet: ReadonlyMap<string, number>;
  inspectorVisible: boolean;
  inspectedId: string | null;
  deletingId: string | null;
  selectionMode?: boolean;
  isRowSelected: (id: string) => boolean;
  onToggleSelection?: (id: string) => void;
  highlightTransactionId?: string | null;
  onRowClick: (transaction: Transaction) => void;
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
  canEdit: (transaction: Transaction) => boolean;
  canDelete: (transaction: Transaction) => boolean;
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

function amountTone(amount: number, onDark: boolean): string {
  if (amount > 0) return onDark ? 'text-green-300 dark:text-green-700' : 'text-green-700 dark:text-green-400';
  return '';
}

function PebbleRow({
  tx,
  p,
  selected,
  inspected,
  isFuture,
}: {
  tx: Transaction;
  p: PebbleRegisterProps;
  selected: boolean;
  inspected: boolean;
  isFuture: boolean;
}) {
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();
  const label = payeeDisplay(tx);
  const categoryLabel = useCategoryLabel(p.categoryLabelMap)(tx);
  const color = tx.category
    ? (p.categoryColorMap?.get(tx.category.id) ?? tx.category.color)
    : null;
  const categoryIcon = tx.category
    ? (p.categoryIconMap?.get(tx.category.id) ?? tx.category.icon)
    : null;
  const amount = rowAmount(tx, p.displayAmounts);
  const isVoid = tx.status === TransactionStatus.VOID;
  const balance = p.runningBalances.get(tx.id);
  const highlighted = !!p.highlightTransactionId && p.highlightTransactionId === tx.id;
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
      {p.selectionMode && (
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
      <Avatar tx={tx} label={label} color={color} size="md" onInk={inspected} />
      <span className="min-w-0 flex-1 sm:flex-[3_1_0%]">
        <span className={`block truncate font-semibold text-[15px] ${isVoid ? 'line-through' : ''}`}>
          {label || '-'}
          {tx.description && !p.hidden.has('description') && (
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
        {p.displayAmounts.has(tx.id) && <span className="ml-0.5 text-xs font-normal">*</span>}
      </span>
      {p.showRunningBalance && (
        <span className={`hidden md:block shrink-0 w-24 text-right text-sm ${inspected ? 'opacity-70' : 'text-gray-500 dark:text-gray-400'}`}>
          {balance !== undefined ? formatCurrency(balance, tx.currencyCode) : '-'}
        </span>
      )}
    </li>
  );
}

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
  const showDelete = !linked && p.canDelete(tx);
  return (
    // Sticky against the window, so it follows the list. It only sticks once
    // the page title has scrolled away, which is when the floating page bar
    // has slid in under the header, so the offset clears both: the header's
    // still-visible part (4rem less --app-header-offset as it slides away) and
    // the bar (~4rem), plus a gap. Its own height is capped to what is left,
    // scrolling inside when the details run longer.
    <aside
      aria-label={t('list.pebble.inspectorLabel')}
      className="ui-pebble-inspector hidden lg:flex lg:w-[22rem] xl:w-[24rem] shrink-0 self-start sticky top-[calc(8.5rem+env(safe-area-inset-top)-var(--app-header-offset,0px))] max-h-[calc(100dvh-9.5rem-env(safe-area-inset-top)+var(--app-header-offset,0px))] overflow-y-auto flex-col gap-4 rounded-[28px] bg-white p-7 text-gray-900 shadow-card dark:bg-gray-900 dark:text-gray-100 dark:shadow-card-dark"
    >
      <div className="flex items-center gap-3.5">
        <Avatar tx={tx} label={label} color={color} size="lg" />
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
      {(showEdit || showCopy || showSchedule || showDelete) && (
        <div className="flex flex-wrap gap-2">
          {showEdit && (
            <button type="button" className={PILL} onClick={() => p.onEdit?.(tx)}>
              {linked ? t('list.row.viewButton') : tc('edit')}
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

export function PebbleRegister(p: PebbleRegisterProps) {
  const t = useTranslations('transactions');
  const { formatCurrency } = useNumberFormat();
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
    const net = p.dayNet.get(open.date) ?? 0;
    const currency = p.transactions.find((x) => x.transactionDate === open.date)?.currencyCode;
    nodes.push(
      <section key={open.date} aria-label={groupTitle(open.date)}>
        <div className="flex items-baseline justify-between px-1.5 pt-4 pb-2">
          <h3 className="!font-sans !text-sm font-semibold text-gray-900 dark:text-gray-100">
            {groupTitle(open.date)}
          </h3>
          <span className={net > 0 ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}>
            {net > 0 ? '+' : ''}{formatCurrency(net, currency)}
          </span>
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
    cur.open.rows.push(
      <PebbleRow
        key={tx.id}
        tx={tx}
        p={p}
        selected={p.selectionMode ? p.isRowSelected(tx.id) : false}
        inspected={p.inspectorVisible && inspected?.id === tx.id}
        isFuture={tx.transactionDate > p.today}
      />,
    );
  });
  flush();

  return (
    <div className="ui-pebble-register flex items-start gap-6 px-4 pb-4">
      <div className="min-w-0 flex-1">
        {p.sortStrip}
        {nodes}
      </div>
      {p.inspectorVisible && inspected && <Inspector tx={inspected} p={p} />}
    </div>
  );
}
