'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { countElapsedPeriods } from '@/lib/chart-buckets';
import { sumMoney } from '@/lib/format';
import { netEntityTotal } from '@/components/transactions/widget-shared';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';
import type { CategoryDetail } from '@/types/category';

/** Income/expense totals reduced to the display currency. */
export interface CategoryPeriodTotals {
  income: number;
  expenses: number;
  net: number;
}

interface CategorySummaryCardsProps {
  detail: CategoryDetail;
  /** Lifetime totals, for the average transaction size. */
  lifetimeTotals: CategoryPeriodTotals | null;
  /** Jan 1 to today. */
  thisYearTotals: CategoryPeriodTotals | null;
  /** Jan 1 to the same date, one year earlier. */
  lastYearTotals: CategoryPeriodTotals | null;
  /** The category's whole monthly history, for the monthly average. */
  monthlyTotals: MonthlyTotal[];
  currencyStrategy: DisplayCurrencyStrategy;
  /** True when the summaries span more than one currency (figures converted). */
  isMultiCurrency: boolean;
  /** The Transactions card opens the page's Transactions tab. */
  onTransactionsClick: () => void;
}

/**
 * The key-figure row. An income category's headline is "Received this year" in
 * green rather than "Spent this year" in red -- unlike a payee, whose framing
 * has to be inferred from history, the category declares its type.
 */
export function CategorySummaryCards({
  detail,
  lifetimeTotals,
  thisYearTotals,
  lastYearTotals,
  monthlyTotals,
  currencyStrategy,
  isMultiCurrency,
  onTransactionsClick,
}: CategorySummaryCardsProps) {
  const t = useTranslations('categoryDetail');
  const { formatCurrency, formatSignedPercent, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const { stats, category } = detail;
  const displayCurrency = currencyStrategy.displayCurrency;
  const isIncome = category.isIncome;

  const headlineOf = (totals: CategoryPeriodTotals | null) =>
    totals === null ? null : netEntityTotal(totals, isIncome);

  const thisYear = headlineOf(thisYearTotals);
  const lastYear = headlineOf(lastYearTotals);

  // Year-over-year, same window: Jan 1 to today vs Jan 1 to today last year.
  const yoyNote = (() => {
    if (thisYear === null || lastYear === null) return undefined;
    if (lastYear === 0) {
      return thisYear === 0 ? undefined : t('summary.vsLastYearNew');
    }
    const percent = ((thisYear - lastYear) / lastYear) * 100;
    return t('summary.vsLastYear', { percent: formatSignedPercent(percent) });
  })();

  // Average spend per elapsed month over the whole history, including months
  // with no transaction -- the intuitive "total spend / months elapsed", and
  // the same figure the register's category widget shows.
  const monthlyAverage = useMemo(() => {
    if (monthlyTotals.length === 0) return null;
    // A month without a rate has no total: the average is unknown, not partial.
    if (monthlyTotals.some((m) => m.total === null)) return null;
    const sum = sumMoney(monthlyTotals.map((m) => Math.abs(m.total as number)));
    const elapsedMonths = countElapsedPeriods(monthlyTotals, 'month');
    return elapsedMonths > 0 ? sum / elapsedMonths : null;
  }, [monthlyTotals]);

  const monthlyAverageUnknown = monthlyTotals.some((m) => m.total === null);

  const averageTransaction =
    lifetimeTotals !== null && stats.transactionCount > 0
      ? (lifetimeTotals.income + lifetimeTotals.expenses) / stats.transactionCount
      : null;

  const firstYear = stats.firstTransactionDate?.slice(0, 4) ?? null;

  const convertedNote = isMultiCurrency
    ? t('summary.convertedNote', { currency: displayCurrency })
    : undefined;

  const cards: SummaryCardItem[] = [
    {
      label: isIncome ? t('summary.receivedThisYear') : t('summary.spentThisYear'),
      value: thisYear !== null ? formatCurrency(thisYear, displayCurrency) : '—',
      valueClass: isIncome
        ? 'text-green-600 dark:text-green-400'
        : 'text-red-600 dark:text-red-400',
      note: yoyNote ?? convertedNote,
    },
    {
      label: t('summary.monthlyAverage'),
      value:
        monthlyAverage !== null ? formatCurrency(monthlyAverage, monthlyTotals.find((m) => m.currency)?.currency ?? displayCurrency) : '—',
      note: monthlyAverageUnknown ? t('summary.partialRatesNote') : convertedNote,
    },
    {
      label: t('summary.averageTransaction'),
      value:
        averageTransaction !== null
          ? formatCurrency(averageTransaction, displayCurrency)
          : '—',
      note: convertedNote,
    },
    {
      label: t('summary.transactions'),
      value: formatNumber(stats.transactionCount, 0),
      note: firstYear ? t('summary.sinceYear', { year: firstYear }) : undefined,
      onClick: onTransactionsClick,
    },
    {
      label: t('summary.lastTransaction'),
      value: stats.lastTransactionDate ? formatDate(stats.lastTransactionDate) : '—',
    },
  ];

  return (
    <SummaryCardGrid
      cards={cards}
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4"
    />
  );
}
