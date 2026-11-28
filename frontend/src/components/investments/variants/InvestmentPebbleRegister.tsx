'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { InvestmentTransaction } from '@/types/investment';
import { TransactionStatus } from '@/types/transaction';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';
import type { HideableColumn } from '@/lib/hidden-columns';
import {
  previousDay,
  registerGroupLabel,
} from '@/components/transactions/register-style-data';
import {
  InvestmentPriceValue,
  InvestmentSharesValue,
  InvestmentTotalValue,
  useInvestmentActionInfo,
  type InvestmentActionInfo,
} from '@/components/investments/InvestmentTransactionListParts';

type FormatCurrency = (amount: number, currencyCode?: string, fractionDigits?: number) => string;

export interface InvestmentPebbleRegisterProps {
  /** Server-ordered by date, newest first, so a change of date is a new day. */
  transactions: InvestmentTransaction[];
  /** The user's own calendar day (`useFinancialToday`). */
  today: string;
  /** The first row dated today or earlier; the Today divider goes before it. */
  futureBoundaryIndex: number;
  accountMap: ReadonlyMap<string, string>;
  defaultCurrency: string;
  formatCurrency: FormatCurrency;
  formatQuantity: (value: number) => string;
  /** The list's long-press handlers: a click edits, a long press opens the sheet. */
  getRowHandlers: (tx: InvestmentTransaction) => LongPressRowHandlers;
  onEdit?: (tx: InvestmentTransaction) => void;
  onCycleStatus: (tx: InvestmentTransaction) => void;
  /** The register's hidden columns; each is absent from the row too. */
  hidden: ReadonlySet<HideableColumn<'investmentRegister'>>;
  /** Shown in place of the blocks when a filter left no rows. */
  emptyText: string;
}

interface PebbleTradeRowProps {
  tx: InvestmentTransaction;
  actionInfo: InvestmentActionInfo;
  accountName: string | undefined;
  isFuture: boolean;
  p: InvestmentPebbleRegisterProps;
}

/** The security's initial on a round disc, as Pebble's payee avatar draws a payee's. */
function SecurityAvatar({ symbol }: { symbol: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="h-9 w-9 text-sm shrink-0 rounded-full flex items-center justify-center font-bold bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
    >
      {(symbol ?? '-').trim().charAt(0).toUpperCase() || '-'}
    </span>
  );
}

/**
 * One trade. It shows the figures the tier row shows, through the same three
 * renderers, so a SPLIT's ratio, an unpriced row and a redemption's total read
 * the same in every layout. A click edits the trade, as the tier row does;
 * there is no inspector (issue #2510).
 */
function PebbleTradeRow({ tx, actionInfo, accountName, isFuture, p }: PebbleTradeRowProps) {
  const isVoid = tx.status === TransactionStatus.VOID;
  const voidText = isVoid ? 'line-through' : '';
  const isVisible = (id: string) => !(p.hidden as ReadonlySet<string>).has(id);
  const symbol = tx.security?.symbol;
  const { onEdit } = p;
  return (
    <li
      data-testid="pebble-trade-row"
      {...p.getRowHandlers(tx)}
      tabIndex={onEdit ? 0 : undefined}
      onKeyDown={
        onEdit
          ? (e) => {
              // A key on the status button is the button's, not the row's.
              if (e.target !== e.currentTarget) return;
              activateOnKey(() => onEdit(tx))(e);
            }
          : undefined
      }
      className={`ui-pebble-row flex items-center gap-3 sm:gap-3.5 min-h-[60px] px-3 sm:px-3.5 py-2 rounded-2xl select-none touch-manipulation border-t border-gray-100 first:border-t-0 dark:border-gray-800 ${HOVER_ROW_ON_PAGE} ${onEdit ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''} ${isVoid ? 'opacity-50' : ''} ${isFuture && !isVoid ? 'opacity-60' : ''}`}
    >
      <SecurityAvatar symbol={symbol} />
      <span className="min-w-0 flex-1 sm:flex-[3_1_0%]">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className={`truncate font-semibold text-[15px] text-gray-900 dark:text-gray-100 ${voidText}`}>
            {symbol || '-'}
          </span>
          <span className={`min-w-0 truncate text-sm font-medium ${actionInfo.color}`}>
            {actionInfo.label}
          </span>
        </span>
        {tx.security?.name && (
          <span className="block truncate text-xs text-gray-500 dark:text-gray-400" title={tx.security.name}>
            {tx.security.name}
          </span>
        )}
        {/* Phones put the status under the name, as the cash register's
            Pebble row does: the same tappable control, never the row's click. */}
        {isVisible('status') && (
          <span className="sm:hidden block -ml-1 [&>button]:text-xs [&>button]:px-2">
            <StatusCellButton status={tx.status} dense={false} onCycle={() => p.onCycleStatus(tx)} />
          </span>
        )}
      </span>
      {(isVisible('shares') || isVisible('price')) && (
        <span className={`hidden md:flex flex-col items-end shrink-0 text-sm text-gray-500 dark:text-gray-400 ${voidText}`}>
          {isVisible('shares') && (
            <span className="whitespace-nowrap">
              <InvestmentSharesValue tx={tx} formatQuantity={p.formatQuantity} />
            </span>
          )}
          {isVisible('price') && (
            <span className="whitespace-nowrap">
              <InvestmentPriceValue tx={tx} formatCurrency={p.formatCurrency} defaultCurrency={p.defaultCurrency} />
            </span>
          )}
        </span>
      )}
      <span className="hidden lg:block min-w-0 lg:flex-[2_1_0%] truncate text-sm text-gray-500 dark:text-gray-400" title={accountName}>
        {accountName || '-'}
      </span>
      {isVisible('status') && (
        <span className="hidden sm:flex shrink-0 w-24 justify-start">
          <StatusCellButton status={tx.status} dense={false} onCycle={() => p.onCycleStatus(tx)} />
        </span>
      )}
      <span className={`shrink-0 text-right font-semibold text-[15px] sm:min-w-28 whitespace-nowrap text-gray-900 dark:text-gray-100 ${voidText}`}>
        <InvestmentTotalValue tx={tx} formatCurrency={p.formatCurrency} defaultCurrency={p.defaultCurrency} />
      </span>
    </li>
  );
}

/**
 * The brokerage register in the Pebble UI style (issue #2510): trades grouped
 * by day in white blocks under a Today / Yesterday / date title, a round
 * avatar per security and the total large on the right, as the cash
 * register's `PebbleRegister` draws its rows.
 *
 * The day title carries the date alone. A trade register has no running
 * balance, and a day's net across trades would be a client-side sum of rows
 * in their own currencies (`frontend/CLAUDE.md`, "An investment row's money").
 * There is no inspector: a click opens the editor, as the tier row does.
 */
export function InvestmentPebbleRegister(p: InvestmentPebbleRegisterProps) {
  const t = useTranslations('transactions');
  const tInv = useTranslations('investments');
  const locale = useLocale();
  const actionInfoFor = useInvestmentActionInfo();

  if (p.transactions.length === 0) {
    return (
      <p className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">{p.emptyText}</p>
    );
  }

  const groupTitle = (date: string) =>
    date === p.today
      ? t('list.today')
      : date === previousDay(p.today)
        ? t('list.pebble.yesterday')
        : registerGroupLabel(date, locale, p.today);

  const nodes: React.ReactNode[] = [];
  const cur: { open: { date: string; rows: React.ReactNode[] } | null } = { open: null };
  const flush = () => {
    const open = cur.open;
    if (!open) return;
    const title = groupTitle(open.date);
    nodes.push(
      <section key={`${open.date}-${nodes.length}`} aria-label={title}>
        <div className="px-1.5 pt-4 pb-2">
          <h3 className="!font-sans !text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
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
    if (index === p.futureBoundaryIndex && p.futureBoundaryIndex > 0) {
      flush();
      nodes.push(
        <div key="today-divider" className="flex items-center gap-3 px-1.5 pt-4">
          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider whitespace-nowrap">
            {tInv('transactionList.today')}
          </span>
          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
        </div>,
      );
    }
    if (!cur.open) cur.open = { date: tx.transactionDate, rows: [] };
    cur.open.rows.push(
      <PebbleTradeRow
        key={tx.id}
        tx={tx}
        actionInfo={actionInfoFor(tx.action)}
        accountName={p.accountMap.get(tx.accountId)}
        isFuture={tx.transactionDate > p.today}
        p={p}
      />,
    );
  });
  flush();

  return <div className="ui-pebble-register px-4 pb-4">{nodes}</div>;
}
