'use client';

import { useTranslations } from 'next-intl';
import {
  SummaryCardGrid,
  type SummaryCardItem,
} from '@/components/accounts/shared/SummaryCardGrid';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  summarizeRatePeriod,
  summarizeRateSpread,
  type RateHistoryRow,
} from '@/lib/currency-detail';

interface CurrencyPeriodSummaryProps {
  code: string;
  defaultCurrency: string;
  /** The rate rows dated inside the selected period. */
  rows: readonly RateHistoryRow[];
}

/**
 * The selected period in two figures: how many rates it holds and the dates
 * they span, and how far the reader's own transactions settled from the
 * stored market rate for their dates (`summarizeRateSpread`). A transaction
 * with no stored rate for its date is named as unmeasured rather than
 * averaged in, and the note says how to fetch the rate it is missing.
 */
export function CurrencyPeriodSummary({ code, defaultCurrency, rows }: CurrencyPeriodSummaryProps) {
  const t = useTranslations('currencyDetail');
  const { formatNumber, formatPercent } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const period = summarizeRatePeriod(rows);
  const spread = summarizeRateSpread(rows);

  const spreadNote = (): string => {
    if (spread.measured === 0 && spread.unmeasured === 0) return t('period.noTransactions');
    if (spread.unmeasured === 0) return t('period.spreadNote', { count: spread.measured });
    // What is missing, exactly: the pair and the oldest date it is missing on.
    const missing = {
      pair: `${code}->${defaultCurrency}`,
      date: spread.earliestUnmeasured ? formatDate(spread.earliestUnmeasured) : '',
    };
    if (spread.measured === 0) {
      return t('period.spreadNoneMeasured', { count: spread.unmeasured, ...missing });
    }
    return t('period.spreadNoteUnmeasured', {
      measured: spread.measured,
      unmeasured: spread.unmeasured,
      ...missing,
    });
  };

  const cards: SummaryCardItem[] = [
    {
      label: t('period.rates'),
      value: formatNumber(period.count, 0),
      note:
        period.firstDate && period.lastDate
          ? t('period.ratesSpan', {
              start: formatDate(period.firstDate),
              end: formatDate(period.lastDate),
            })
          : t('period.noRates'),
    },
    {
      label: t('period.averageSpread'),
      value: spread.averagePercent === null ? '—' : formatPercent(spread.averagePercent, 2),
      note: spreadNote(),
    },
  ];

  return <SummaryCardGrid cards={cards} className="grid grid-cols-1 sm:grid-cols-2 gap-4" />;
}
