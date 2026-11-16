'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { exchangeRatesApi, RateCoverage } from '@/lib/exchange-rates';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('RateHistoryCoverage');

interface RateHistoryCoverageProps {
  /** The currency being looked at. Its pair is this against the reporting currency. */
  code: string;
  /**
   * The reader's reporting currency, where the surface already has the
   * server's answer (the detail page's); the client preference otherwise.
   */
  reportingCurrency?: string;
  /** The heading; the currency form's "Rate history" by default. */
  title?: string;
  /**
   * The heading's level: `h3` under the currency form's own heading, `h2` on
   * the detail page, where it sits beside the page's other sections.
   */
  headingLevel?: 'h2' | 'h3';
  /**
   * The wrapper's frame. By default the rule that sets the section apart
   * inside the currency form; the detail page puts it in a card instead.
   */
  className?: string;
  /**
   * Called after a fill stored rates, for a surface that shows the history
   * itself (the detail page's chart and table) and must re-read it too.
   */
  onFilled?: () => void;
}

/**
 * What the state of this panel belongs to.
 *
 * Stamped with the code it answers for, because the panel is remounted with a
 * different currency while a read is in flight and a payload without its
 * request key is just a payload: a late EUR response must not render under a
 * USD heading.
 */
interface PanelState {
  code: string;
  coverage: RateCoverage | null;
  coverageFailed: boolean;
}

/**
 * What exchange rate history is stored for this currency, and a way to fill in
 * what is missing from it.
 *
 * The stored history of a pair usually starts the day the daily refresh first
 * ran, so a report dated earlier reports "no exchange rate" for dates the
 * provider does in fact have. Filling it is a shared write, but it needs no
 * admin rights: the pair is always this currency against the reader's own
 * reporting currency, the span is the one their own data uses, and the number
 * of provider windows per press is bounded.
 *
 * Deliberately rendered OUTSIDE the currency form's `<form>`: none of this is
 * a field, and a section that marked the form dirty would arm the unsaved-changes
 * prompt for a button that saves nothing of the user's.
 */
export function RateHistoryCoverage({
  code,
  reportingCurrency,
  title,
  headingLevel: Heading = 'h3',
  className = 'border-t border-gray-200 dark:border-gray-700 pt-4',
  onFilled,
}: RateHistoryCoverageProps) {
  const t = useTranslations('currencies');
  const { defaultCurrency: preferredCurrency } = useExchangeRates();
  const defaultCurrency = reportingCurrency ?? preferredCurrency;
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  const [panel, setPanel] = useState<PanelState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFilling, setIsFilling] = useState(false);

  const pair = `${code}->${defaultCurrency}`;
  // 1 is not a stored rate, so there is no history for a currency against
  // itself and nothing to fill.
  const sameCurrency = code === defaultCurrency;

  // A new request input means a new read: show it as loading from this render
  // on ("info from previous render"), rather than from inside the effect.
  const requestKey = `${code}|${sameCurrency}`;
  const [loadingKey, setLoadingKey] = useState(requestKey);
  if (loadingKey !== requestKey) {
    setLoadingKey(requestKey);
    setIsLoading(true);
  }

  // Read in the effect below, and by the fill's completion, to decide whether
  // what came back is still about the currency on screen.
  const currentCode = useRef(code);
  useLayoutEffect(() => {
    currentCode.current = code;
  });

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const load = useCallback(() => {
    const run = async () => {
      const requestCode = code;
      let coverage: RateCoverage | null = null;
      try {
        coverage = await exchangeRatesApi.getRateCoverage(requestCode);
      } catch (error) {
        logger.error('Rate coverage load failed:', error);
      }
      if (currentCode.current !== requestCode) return;

      setPanel({ code: requestCode, coverage, coverageFailed: coverage === null });
      setIsLoading(false);
    };
    return run();
  }, [code]);

  useEffect(() => {
    if (sameCurrency) return;
    void load();
  }, [sameCurrency, load]);

  const handleFill = useCallback(async () => {
    setIsFilling(true);
    const requestCode = code;
    try {
      const result = await exchangeRatesApi.fillRateGaps(requestCode);
      if (currentCode.current !== requestCode) return;

      if (result.usedFrom === null) {
        // Nothing of the reader's is denominated in it, so no report of theirs
        // needs the rate. Nothing was fetched, and nothing should have been.
        toast.error(t('rateHistory.toasts.unused', { code: requestCode }));
      } else if (result.stored > 0) {
        const added = {
          count: formatNumber(result.stored, 0),
          start: result.earliestDate ? formatDate(result.earliestDate) : '',
        };
        toast.success(
          result.windowsRemaining > 0
            ? t('rateHistory.toasts.partial', {
                ...added,
                windows: formatNumber(result.windowsRemaining, 0),
              })
            : t('rateHistory.toasts.filled', added),
        );
      } else if (result.providerHasNothingBefore) {
        // The provider answered and had nothing that far back. Not a failure,
        // and asking again will not change it.
        toast.error(
          t('rateHistory.toasts.providerFloor', {
            pair,
            date: formatDate(result.providerHasNothingBefore),
          }),
        );
      } else if (result.windowsRemaining > 0) {
        // Nothing came back this time, but the fill did not get through the
        // whole span either: saying only "no new rates" would read as a dead
        // end rather than as work still to do.
        toast.error(
          t('rateHistory.toasts.moreToFetch', {
            windows: formatNumber(result.windowsRemaining, 0),
          }),
        );
      } else if (result.windowsPlanned === 0) {
        toast.success(t('rateHistory.toasts.noGaps', { pair }));
      } else {
        toast.error(t('rateHistory.toasts.noNewRates', { pair }));
      }
      // Re-read rather than patch: the server decides what is stored, and it
      // has just written rows this component has never seen.
      setIsLoading(true);
      if (result.stored > 0) onFilled?.();
      await load();
    } catch (error) {
      logger.error('Rate gap fill failed:', error);
      if (currentCode.current !== requestCode) return;
      toast.error(getErrorMessage(error, t('rateHistory.toasts.failed')));
    } finally {
      setIsFilling(false);
    }
  }, [code, pair, t, formatNumber, formatDate, load, onFilled]);

  if (sameCurrency) return null;

  const current = panel?.code === code ? panel : null;
  const coverage = current?.coverage ?? null;
  const hasStoredHistory = !!coverage?.earliestDate && !!coverage?.latestDate;

  return (
    <div className={`${className} space-y-2`}>
      <Heading className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {title ?? t('rateHistory.title')}
      </Heading>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {isLoading
          ? t('rateHistory.loading')
          : current?.coverageFailed
            ? t('rateHistory.loadFailed')
            : hasStoredHistory
              ? t('rateHistory.stored', {
                  start: formatDate(coverage!.earliestDate!),
                  end: formatDate(coverage!.latestDate!),
                  count: formatNumber(coverage!.observations, 0),
                })
              : t('rateHistory.none', { pair })}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('rateHistory.hint', { pair })}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={handleFill}
        disabled={isFilling}
        title={t('rateHistory.fillGapsTitle', { code })}
      >
        {isFilling ? t('rateHistory.filling') : t('rateHistory.fillGaps')}
      </Button>
    </div>
  );
}
