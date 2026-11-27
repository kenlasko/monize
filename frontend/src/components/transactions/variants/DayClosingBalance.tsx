'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { balanceColor } from '@/lib/format';
import type { SortDirection } from '@/hooks/useSortableTable';
import type { DayClosingBalances } from '../register-style-data';

interface DayClosingBalanceProps {
  date: string;
  closing: DayClosingBalances;
  /** The account's currency: one account's register is one currency. */
  currencyCode: string | undefined;
  /** The register's order, which says which page holds a continued day's close. */
  direction: SortDirection;
  className?: string;
}

/**
 * The balance a day closed on, for a phone register's date heading (Folio's
 * wrapped card, Pebble below `md`), where the rows draw no Balance column
 * (issue #2486). Both styles draw it here so a balance reads one way in both,
 * signed and coloured as the Folio balance column is.
 *
 * The figure is named for a screen reader, since the same place shows the
 * day's net where there is no running balance. A day whose newest rows are on
 * the neighbouring page says so rather than print a mid-day balance as its
 * close; a day with no balance at all is unknown and reads as a dash.
 */
export function DayClosingBalance({
  date,
  closing,
  currencyCode,
  direction,
  className = '',
}: DayClosingBalanceProps) {
  const t = useTranslations('transactions');
  const { formatCurrency } = useNumberFormat();
  const balance = closing.balances.get(date);

  let figure: ReactNode;
  if (closing.continuedDate === date) {
    figure = (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {direction === 'asc' ? t('list.dayHeading.continuedNext') : t('list.dayHeading.continuedPrevious')}
      </span>
    );
  } else if (balance === undefined) {
    figure = <span className="text-gray-500 dark:text-gray-400">-</span>;
  } else {
    const formatted = formatCurrency(Math.abs(balance), currencyCode);
    figure = <span className={balanceColor(balance)}>{balance < 0 ? `-${formatted}` : formatted}</span>;
  }

  return (
    <span className={className} data-testid="day-closing-balance">
      <span className="sr-only">{t('list.dayHeading.closingBalance')}</span>
      <span data-testid="day-closing-balance-figure">{figure}</span>
    </span>
  );
}
