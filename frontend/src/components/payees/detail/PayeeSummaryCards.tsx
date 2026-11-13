'use client';

import { useTranslations } from 'next-intl';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { PayeeDetail } from '@/types/payee';

/** Income/expense totals reduced to the display currency. */
export interface PayeePeriodTotals {
  income: number;
  expenses: number;
  net: number;
}

/**
 * The payee's dominant detected cadence, with its latest and previous amounts
 * in the currency it was billed in (`currencyCode`), not converted.
 */
export interface PayeeRecurringSummary {
  cadence: string;
  amount: number;
  previousAmount: number;
  currencyCode: string;
}

interface PayeeSummaryCardsProps {
  detail: PayeeDetail;
  /** Lifetime totals; decides the spending vs income framing. */
  lifetimeTotals: PayeePeriodTotals | null;
  /** Jan 1 to today. */
  thisYearTotals: PayeePeriodTotals | null;
  /** Jan 1 to the same date, one year earlier. */
  lastYearTotals: PayeePeriodTotals | null;
  recurring: PayeeRecurringSummary | null;
  currencyStrategy: DisplayCurrencyStrategy;
  /** True when the summaries span more than one currency (figures converted). */
  isMultiCurrency: boolean;
  /** Apply-default-category flow for the Uncategorized card. */
  onUncategorizedClick: () => void;
}

/**
 * The key-figure row. For a payee that mostly pays the user (an employer, a
 * pension), the headline flips from "Spent this year" to "Received this year"
 * -- calling a salary "spending" and colouring it red reads as a bug.
 */
export function PayeeSummaryCards({
  detail,
  lifetimeTotals,
  thisYearTotals,
  lastYearTotals,
  recurring,
  currencyStrategy,
  isMultiCurrency,
  onUncategorizedClick,
}: PayeeSummaryCardsProps) {
  const t = useTranslations('payeeDetail');
  const { formatCurrency, formatSignedPercent, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const { stats, payee } = detail;
  const displayCurrency = currencyStrategy.displayCurrency;

  const isIncomePayee =
    lifetimeTotals !== null && lifetimeTotals.income > lifetimeTotals.expenses;

  const headlineOf = (totals: PayeePeriodTotals | null) =>
    totals === null ? null : isIncomePayee ? totals.income : totals.expenses;

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

  const averageTransaction =
    lifetimeTotals !== null && stats.transactionCount > 0
      ? (lifetimeTotals.income + lifetimeTotals.expenses) / stats.transactionCount
      : null;

  const firstYear = stats.firstTransactionDate?.slice(0, 4) ?? null;

  const priceChangeNote = (() => {
    if (!recurring || recurring.previousAmount === recurring.amount) return undefined;
    const key = recurring.amount > recurring.previousAmount ? 'summary.priceUp' : 'summary.priceDown';
    return t(key, {
      amount: formatCurrency(recurring.previousAmount, recurring.currencyCode),
    });
  })();

  const convertedNote = isMultiCurrency
    ? t('summary.convertedNote', { currency: displayCurrency })
    : undefined;

  const cards: SummaryCardItem[] = [
    {
      label: isIncomePayee ? t('summary.receivedThisYear') : t('summary.spentThisYear'),
      value:
        thisYear !== null ? formatCurrency(thisYear, displayCurrency) : '—',
      valueClass: isIncomePayee
        ? 'text-green-600 dark:text-green-400'
        : 'text-red-600 dark:text-red-400',
      note: yoyNote ?? convertedNote,
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
    },
    {
      label: t('summary.lastTransaction'),
      value: stats.lastTransactionDate ? formatDate(stats.lastTransactionDate) : '—',
    },
  ];

  if (recurring) {
    cards.push({
      label: t('summary.recurring'),
      value: t('summary.recurringValue', {
        cadence: t(`cadence.${recurring.cadence}`),
        amount: formatCurrency(recurring.amount, recurring.currencyCode),
      }),
      note: priceChangeNote,
    });
  }

  if (stats.uncategorizedCount > 0) {
    cards.push({
      label: t('summary.uncategorized'),
      value: formatNumber(stats.uncategorizedCount, 0),
      valueClass: 'text-yellow-600 dark:text-yellow-400',
      note: payee.defaultCategoryId
        ? t('summary.uncategorizedApply')
        : t('summary.uncategorizedSetDefault'),
      onClick: onUncategorizedClick,
    });
  }

  return (
    <SummaryCardGrid
      cards={cards}
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4"
    />
  );
}
