'use client';

import { useTranslations } from 'next-intl';
import type { BalanceForecastGap } from '@/types/banking-detail';

interface BalanceForecastUnavailableProps {
  /**
   * The schedules the server could not price. MAY be empty: the panel renders
   * on the server's own `complete === false`, and a response can withhold the
   * projection without attributing it (an unrecognised gap reason, a narrowed
   * payload, a cause the server cannot name). Gating the panel on this list
   * being non-empty is what let a withheld forecast render as no notice at all
   * beside the current balance printed under "Projected" -- so the empty case
   * gets a line saying the reason is unavailable, not an empty bullet list.
   */
  gaps: BalanceForecastGap[];
  /**
   * Which of the two reasons there is no forward line.
   *
   * `withheld` is the server declining to project (the cumulative-series rule);
   * `requestFailed` is never having heard back. They call for different words --
   * one describes the data, the other an outage the reader can retry -- and
   * folding them together would present an outage as a property of the user's
   * schedules.
   */
  reason?: 'withheld' | 'requestFailed';
}

/**
 * Why an account's projected balance is missing, and what the reader can do
 * about it.
 *
 * A projected balance is cumulative: one scheduled occurrence nobody can price
 * makes every day after it wrong, so the server withholds the forward line
 * rather than drawing a plausible one (issue #1247,
 * `docs/financial-semantics.md`). A blank chart on its own is indistinguishable
 * from "nothing scheduled", which is why this names the schedule, the currency
 * pair behind it, and the fix.
 *
 * Same shape as the cash-flow forecast's own unavailable panel
 * (`components/bills/CashFlowForecastPlot.tsx`): an amber `role="alert"` block
 * where the chart would be.
 */
export function BalanceForecastUnavailable({
  gaps,
  reason = 'withheld',
}: BalanceForecastUnavailableProps) {
  const t = useTranslations('accountDetail');

  // What is missing for one schedule, by reason; the pair is named when there
  // is one to fix.
  const gapText = (gap: BalanceForecastGap): string => {
    const pair = gap.fromCurrency && gap.toCurrency
      ? { name: gap.name, from: gap.fromCurrency, to: gap.toCurrency }
      : null;
    switch (gap.reason) {
      case 'crossCurrencyTransfer':
        return t('forecastUnavailable.crossCurrencyTransfer', {
          name: gap.name,
          from: gap.fromCurrency ?? '',
          to: gap.toCurrency ?? '',
        });
      case 'unknownEstimate':
        return pair
          ? t('forecastUnavailable.unknownEstimatePair', pair)
          : t('forecastUnavailable.unknownEstimate', { name: gap.name });
      default:
        return pair
          ? t('forecastUnavailable.missingRatePair', pair)
          : t('forecastUnavailable.missingRate', { name: gap.name });
    }
  };

  if (reason === 'requestFailed') {
    return (
      <div
        role="alert"
        data-testid="balance-forecast-unavailable"
        className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
      >
        <p>{t('forecastUnavailable.requestFailed')}</p>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="balance-forecast-unavailable"
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
    >
      <p>{t('forecastUnavailable.intro')}</p>
      {gaps.length === 0 && (
        <p className="mt-2">{t('forecastUnavailable.reasonUnavailable')}</p>
      )}
      {gaps.length > 0 && (
      <ul className="mt-2 list-disc pl-5 space-y-1">
        {gaps.map((gap) => (
          <li key={gap.scheduledTransactionId}>
            {gapText(gap)}
          </li>
        ))}
      </ul>
      )}
      {/* The fix, not just the diagnosis. Only the rate case has one the reader
          can act on; a cross-currency transfer's arriving amount is genuinely
          not knowable until it posts. */}
      {gaps.some(
        (gap) =>
          gap.reason === 'unresolvedSettlementRate' ||
          (gap.reason === 'unknownEstimate' && gap.fromCurrency !== null),
      ) && (
        <p className="mt-2">{t('forecastUnavailable.howToFix')}</p>
      )}
    </div>
  );
}
