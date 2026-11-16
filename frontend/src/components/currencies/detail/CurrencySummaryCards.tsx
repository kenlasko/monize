'use client';

import { useTranslations } from 'next-intl';
import {
  SummaryCardGrid,
  summaryGridClass,
  type SummaryCardItem,
} from '@/components/accounts/shared/SummaryCardGrid';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { CurrencyUsageSummary } from '@/lib/exchange-rates';
import { rateDisplayDecimals, type RateHistoryRow } from '@/lib/currency-detail';
import { useRateSourceLabel } from './useRateSourceLabel';

interface CurrencySummaryCardsProps {
  code: string;
  defaultCurrency: string;
  usage: CurrencyUsageSummary;
  /**
   * The newest provider observation with a known rate, or `null` when there is
   * none; `undefined` while the rate history has not loaded (or failed to),
   * which leaves the card out rather than claiming there is no rate.
   */
  latestRate: RateHistoryRow | null | undefined;
}

/**
 * The key-figure row: how many of the reader's transactions use the
 * currency, what they add up to in it and in the reporting currency, and the
 * latest stored rate. The reporting currency's own page has neither a second
 * total nor a rate, since both would only restate the first total and 1.
 */
export function CurrencySummaryCards({
  code,
  defaultCurrency,
  usage,
  latestRate,
}: CurrencySummaryCardsProps) {
  const t = useTranslations('currencyDetail');
  const { formatCurrency, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const sourceLabel = useRateSourceLabel();
  const isDefault = code === defaultCurrency;

  const firstYear = usage.firstTransactionDate?.slice(0, 4) ?? null;

  const cards: SummaryCardItem[] = [
    {
      label: t('summary.transactions'),
      value: formatNumber(usage.transactionCount, 0),
      note: firstYear ? t('summary.sinceYear', { year: firstYear }) : undefined,
    },
    {
      label: t('summary.totalIn', { currency: code }),
      value:
        usage.totalInCurrency === null
          ? '—'
          : formatCurrency(usage.totalInCurrency, code),
      note:
        usage.totalInCurrency === null
          ? t('summary.totalInCurrencyUnknown', { currency: code })
          : t('summary.grossNote'),
    },
  ];

  if (!isDefault) {
    const complete = usage.totalInReportingCurrency !== null;
    cards.push({
      label: complete
        ? t('summary.totalIn', { currency: usage.reportingCurrency })
        : t('summary.convertedPartIn', { currency: usage.reportingCurrency }),
      // A partial sum is shown under its own caption, never under "Total".
      value: formatCurrency(
        complete
          ? (usage.totalInReportingCurrency as number)
          : usage.knownReportingSubtotal,
        usage.reportingCurrency,
      ),
      valueClass: complete ? undefined : 'text-amber-600 dark:text-amber-400',
      note: complete
        ? t('summary.convertedNote')
        : t('summary.missingRates', {
            count: usage.unconvertedCount,
            pairs: usage.missingPairs.join(', '),
          }),
    });

    if (latestRate !== undefined) {
      cards.push({
        label: t('summary.latestRate'),
        value:
          latestRate && latestRate.rate !== null
            ? t('summary.rateValue', {
                code,
                rate: formatNumber(latestRate.rate, rateDisplayDecimals(latestRate.rate)),
                currency: defaultCurrency,
              })
            : '—',
        note: latestRate
          ? t('summary.rateAsOf', {
              date: formatDate(latestRate.date),
              source: sourceLabel(latestRate.source),
            })
          : t('summary.noStoredRates'),
      });
    }
  }

  return <SummaryCardGrid cards={cards} className={summaryGridClass(cards.length)} />;
}
