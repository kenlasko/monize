'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { PageLayout } from '@/components/layout/PageLayout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CurrencyDetailHeader } from '@/components/currencies/detail/CurrencyDetailHeader';
import { CurrencySummaryCards } from '@/components/currencies/detail/CurrencySummaryCards';
import {
  CurrencyRateChart,
  CurrencyRateChartSkeleton,
} from '@/components/currencies/detail/CurrencyRateChart';
import { CurrencyRateTable } from '@/components/currencies/detail/CurrencyRateTable';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  exchangeRatesApi,
  type CurrencyInfo,
  type CurrencyUsageSummary,
  type StoredRateList,
  type TransactionRateList,
} from '@/lib/exchange-rates';
import { buildRateHistoryRows } from '@/lib/currency-detail';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CurrencyDetail');

export default function CurrencyDetailPage() {
  return (
    <ProtectedRoute>
      <CurrencyDetailContent />
    </ProtectedRoute>
  );
}

/** The page's own figures, stamped with the currency they answer for. */
interface DetailState {
  code: string;
  currencies: CurrencyInfo[];
  usage: CurrencyUsageSummary;
}

/**
 * The rate history, loaded after the figures and failing apart from them: a
 * missing history costs the chart and the table, never the page. Each half is
 * `null` when its read failed, which renders as an error, never as "no rates".
 */
interface RatesState {
  code: string;
  stored: StoredRateList | null;
  transactions: TransactionRateList | null;
}

function CurrencyDetailContent() {
  const t = useTranslations('currencyDetail');
  const { formatNumber } = useNumberFormat();
  const params = useParams();
  const router = useRouter();
  const code = String(params.code ?? '').toUpperCase();

  const [detail, setDetail] = useState<DetailState | null>(null);
  const [rates, setRates] = useState<RatesState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The currency on screen right now, readable from inside an in-flight load:
  // the switcher moves between currencies on the same route, so a load started
  // for the previous one can still be running.
  const shownCodeRef = useRef(code);
  useLayoutEffect(() => {
    shownCodeRef.current = code;
  });

  // Switching currencies shows the spinner again; set during render rather
  // than in the effect that loads the new one.
  const [loadingCode, setLoadingCode] = useState(code);
  if (loadingCode !== code) {
    setLoadingCode(code);
    setIsLoading(true);
    setError(null);
  }

  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      const requested = code;
      const isStale = () => shownCodeRef.current !== requested;
      try {
        const [currencies, usage] = await Promise.all([
          exchangeRatesApi.getCurrencies(true),
          exchangeRatesApi.getCurrencyUsageSummary(requested),
        ]);
        if (isStale()) return;
        setDetail({ code: requested, currencies, usage });
        setIsLoading(false);

        // 1 is not a stored rate: the reporting currency has no history.
        if (usage.reportingCurrency === requested) {
          setRates({ code: requested, stored: null, transactions: null });
          return;
        }
        const [stored, transactions] = await Promise.allSettled([
          exchangeRatesApi.getStoredRates(requested),
          exchangeRatesApi.getTransactionRates(requested),
        ]);
        if (isStale()) return;
        if (stored.status === 'rejected') logger.error('Stored rates failed:', stored.reason);
        if (transactions.status === 'rejected') {
          logger.error('Transaction rates failed:', transactions.reason);
        }
        setRates({
          code: requested,
          stored: stored.status === 'fulfilled' ? stored.value : null,
          transactions: transactions.status === 'fulfilled' ? transactions.value : null,
        });
      } catch (err) {
        if (isStale()) return;
        setError(getErrorMessage(err, t('loadFailed')));
        setIsLoading(false);
      }
    };
    return run();
  }, [code, t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  const reloadRates = useCallback(() => {
    setRates(null);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  // Only the answer for the currency on screen is drawn.
  const shownDetail = detail?.code === code ? detail : null;
  const shownRates = rates?.code === code ? rates : null;
  const ratesFailed =
    shownRates !== null &&
    (shownRates.stored === null || shownRates.transactions === null);

  const rows = useMemo(
    () =>
      shownRates?.stored && shownRates.transactions
        ? buildRateHistoryRows(shownRates.stored.rates, shownRates.transactions.rates)
        : null,
    [shownRates],
  );

  const latestRate = useMemo(() => {
    if (!rows) return undefined;
    return rows.find((row) => !row.transaction && row.rate !== null) ?? null;
  }, [rows]);

  const currency = shownDetail?.currencies.find((c) => c.code === code) ?? null;

  if (isLoading || (!shownDetail && !error)) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner text={t('loading')} />
        </main>
      </PageLayout>
    );
  }

  if (error || !shownDetail || !currency) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div role="alert">
            <EmptyState
              icon={<ExclamationTriangleIcon />}
              title={error ?? t('notFound', { code })}
              action={
                <div className="flex justify-center gap-3">
                  {error && (
                    <Button variant="outline" onClick={loadData}>
                      {t('tryAgain')}
                    </Button>
                  )}
                  <Button onClick={() => router.push('/currencies')}>{t('backToCurrencies')}</Button>
                </div>
              }
            />
          </div>
        </main>
      </PageLayout>
    );
  }

  const { usage } = shownDetail;
  const reportingCurrency = usage.reportingCurrency;
  const isDefault = code === reportingCurrency;

  const notes: string[] = [];
  if (shownRates?.stored?.truncated) {
    notes.push(t('table.storedTruncated', { count: formatNumber(shownRates.stored.limit, 0) }));
  }
  if (shownRates?.transactions?.truncated) {
    notes.push(
      t('table.transactionsTruncated', { count: formatNumber(shownRates.transactions.limit, 0) }),
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <CurrencyDetailHeader
          currency={currency}
          defaultCurrency={reportingCurrency}
          onBack={() => router.push('/currencies')}
          currencies={shownDetail.currencies}
          onSelectCurrency={(next) => router.push(`/currencies/${next}`)}
        />

        <div className="space-y-6">
          <CurrencySummaryCards
            code={code}
            defaultCurrency={reportingCurrency}
            usage={usage}
            latestRate={latestRate}
          />

          {isDefault ? (
            <Card padding="md">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('defaultCurrencyNote', { code })}
              </p>
            </Card>
          ) : ratesFailed ? (
            <div role="alert">
              <EmptyState
                icon={<ExclamationTriangleIcon />}
                title={t('ratesLoadFailed')}
                action={<Button onClick={reloadRates}>{t('tryAgain')}</Button>}
              />
            </div>
          ) : (
            <>
              {rows ? (
                <CurrencyRateChart code={code} defaultCurrency={reportingCurrency} rows={rows} />
              ) : (
                <CurrencyRateChartSkeleton />
              )}

              <section aria-labelledby="currency-rate-history-heading">
                <h2
                  id="currency-rate-history-heading"
                  className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100"
                >
                  {t('table.title')}
                </h2>
                {rows ? (
                  <CurrencyRateTable
                    code={code}
                    defaultCurrency={reportingCurrency}
                    rows={rows}
                    notes={notes}
                  />
                ) : (
                  <Card padding="md">
                    <LoadingSpinner text={t('table.loading')} />
                  </Card>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </PageLayout>
  );
}
