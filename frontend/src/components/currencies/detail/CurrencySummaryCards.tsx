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
import { ProvisionalMark } from '@/components/ui/ProvisionalMark';
import { provisionalCountOf } from '@/lib/provisional-amount';

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

  // The count is over every row, so it is inside the total in the currency
  // and the complete reporting total. A partial reporting subtotal leaves out
  // the rows with no rate, which may be the estimated ones, so it is not
  // marked. The mark sits beside the figure and never replaces it.
  const provisional = provisionalCountOf(usage.provisionalCount) > 0;
  const withProvisionalMark = (figure: string) =>
    provisional ? (
      <span className="inline-flex items-baseline gap-1">
        <span>{figure}</span>
        <ProvisionalMark count={usage.provisionalCount} />
      </span>
    ) : (
      figure
    );

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
          : withProvisionalMark(formatCurrency(usage.totalInCurrency, code)),
      note:
        usage.totalInCurrency === null
          ? t('summary.totalInCurrencyUnknown', { currency: code })
          : t('summary.grossNote'),
    },
  ];

  if (!isDefault) {
    const complete = usage.totalInReportingCurrency !== null;
    // A pair is "FROM->TO" with FROM the currency the rows were posted in, and
    // this page's fill fetches only its own code's pair: a missing rate of a
    // row posted in another currency (paid in this one) is filled from that
    // currency's page.
    const onlyOwnPairs = usage.missingPairs.every((pair) => pair.startsWith(`${code}->`));
    cards.push({
      label: complete
        ? t('summary.totalIn', { currency: usage.reportingCurrency })
        : t('summary.convertedPartIn', { currency: usage.reportingCurrency }),
      // A partial sum is shown under its own caption, never under "Total".
      value: complete
        ? withProvisionalMark(
            formatCurrency(usage.totalInReportingCurrency as number, usage.reportingCurrency),
          )
        : formatCurrency(usage.knownReportingSubtotal, usage.reportingCurrency),
      valueClass: complete ? undefined : 'text-amber-600 dark:text-amber-400',
      note: complete
        ? t('summary.convertedNote')
        : t(onlyOwnPairs ? 'summary.missingRates' : 'summary.missingRatesElsewhere', {
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
