'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import {
  TABLE_CLASS,
  TABLE_BODY_CLASS,
  Th,
  Td,
} from '@/components/ui/Table';
import {
  exchangeRatesApi,
  RateCoverage,
  StoredRateList,
} from '@/lib/exchange-rates';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { FX_RATE_DISPLAY_DECIMALS } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('RateHistoryCoverage');

interface RateHistoryCoverageProps {
  /** The currency being looked at. Its pair is this against the reporting currency. */
  code: string;
  /**
   * List the stored rates, not only the summary above them.
   *
   * True from the dedicated rate history dialog. Left off inside the currency
   * form, where a scrolling table of dates would bury the save button, and
   * where the request is not worth making for a panel nobody opened the dialog
   * to read: the flag gates the fetch, not just the markup.
   */
  showStoredRates?: boolean;
}

/**
 * What the state of this panel belongs to.
 *
 * Stamped with the code it answers for, because the panel is remounted with a
 * different currency while a read is in flight and a payload without its
 * request key is just a payload: a late EUR response must not render under a
 * USD heading. The two reads travel together and fail apart, so a list that
 * could not be read never empties the summary beside it.
 */
interface PanelState {
  code: string;
  coverage: RateCoverage | null;
  coverageFailed: boolean;
  stored: StoredRateList | null;
  storedFailed: boolean;
}

/** The provider slugs `exchange_rates.source` actually holds. */
function sourceKey(
  source: string | null,
):
  | 'yahooFinance'
  | 'yahooCrypto'
  | 'frankfurter'
  | 'mnyImport'
  | null {
  if (source === 'yahoo_finance') return 'yahooFinance';
  if (source === 'yahoo_crypto') return 'yahooCrypto';
  if (source === 'frankfurter') return 'frankfurter';
  if (source === 'mny_import') return 'mnyImport';
  return null;
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
  showStoredRates = false,
}: RateHistoryCoverageProps) {
  const t = useTranslations('currencies');
  const { defaultCurrency } = useExchangeRates();
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
  const requestKey = `${code}|${showStoredRates}|${sameCurrency}`;
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
      const [coverage, stored] = await Promise.allSettled([
        exchangeRatesApi.getRateCoverage(requestCode),
        showStoredRates
          ? exchangeRatesApi.getStoredRates(requestCode)
          : Promise.resolve(null),
      ]);
      if (currentCode.current !== requestCode) return;

      if (coverage.status === 'rejected') {
        logger.error('Rate coverage load failed:', coverage.reason);
      }
      if (stored.status === 'rejected') {
        logger.error('Stored rate load failed:', stored.reason);
      }
      setPanel({
        code: requestCode,
        coverage: coverage.status === 'fulfilled' ? coverage.value : null,
        coverageFailed: coverage.status === 'rejected',
        stored: stored.status === 'fulfilled' ? stored.value : null,
        storedFailed: stored.status === 'rejected',
      });
      setIsLoading(false);
    };
    return run();
  }, [code, showStoredRates]);

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
      await load();
    } catch (error) {
      logger.error('Rate gap fill failed:', error);
      if (currentCode.current !== requestCode) return;
      toast.error(getErrorMessage(error, t('rateHistory.toasts.failed')));
    } finally {
      setIsFilling(false);
    }
  }, [code, pair, t, formatNumber, formatDate, load]);

  if (sameCurrency) return null;

  const current = panel?.code === code ? panel : null;
  const coverage = current?.coverage ?? null;
  const hasStoredHistory = !!coverage?.earliestDate && !!coverage?.latestDate;
  const stored = current?.stored ?? null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-2">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('rateHistory.title')}
      </h3>
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

      {showStoredRates && (
        <div className="space-y-2 pt-2">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('rateHistory.list.heading')}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('rateHistory.list.direction', {
              from: stored?.from ?? code,
              to: stored?.to ?? defaultCurrency,
            })}
          </p>
          {isLoading ? (
            <LoadingSpinner
              size="sm"
              fullContainer={false}
              text={t('rateHistory.list.loading')}
            />
          ) : current?.storedFailed ? (
            // A read that failed is not an empty history, and must never be
            // shown as one.
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('rateHistory.list.loadFailed')}
            </p>
          ) : !stored || stored.rates.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('rateHistory.list.empty')}
            </p>
          ) : (
            <>
              <div className="max-h-96 overflow-y-auto">
                <table className={TABLE_CLASS}>
                  <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
                    <tr>
                      <Th>{t('rateHistory.list.columns.date')}</Th>
                      <Th align="right">
                        {t('rateHistory.list.columns.rate')}
                      </Th>
                      <Th>{t('rateHistory.list.columns.source')}</Th>
                    </tr>
                  </thead>
                  <tbody className={TABLE_BODY_CLASS}>
                    {stored.rates.map((rate) => {
                      const key = sourceKey(rate.source);
                      return (
                        <tr key={rate.rateDate}>
                          <Td className="whitespace-nowrap">
                            {formatDate(rate.rateDate)}
                          </Td>
                          <Td align="right" className="whitespace-nowrap">
                            {rate.rate === null ? (
                              <span className="text-gray-400 dark:text-gray-500">
                                {t('rateHistory.list.unknownRate')}
                              </span>
                            ) : (
                              formatNumber(rate.rate, FX_RATE_DISPLAY_DECIMALS)
                            )}
                            {rate.inverted && (
                              <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">
                                {t('rateHistory.list.inverted')}
                              </span>
                            )}
                          </Td>
                          <Td className="whitespace-nowrap">
                            {key
                              ? t(`rateHistory.list.sources.${key}`)
                              : (rate.source ??
                                t('rateHistory.list.sources.unknown'))}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {stored.truncated && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('rateHistory.list.truncated', {
                    count: formatNumber(stored.limit, 0),
                  })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
