'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BondOfferTab } from '@/components/bonds/BondOfferTab';
import { DateInput } from '@/components/ui/DateInput';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useReportData } from '@/hooks/useReportData';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { groupLotsBySeries } from '@/lib/bond-series';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import type { Security } from '@/types/investment';
import type {
  BondAssumption,
  BondMissingObservation,
  BondProjectionMissing,
  SecurityBondValuation,
} from '@/types/bond';
import { ACTION_LABEL_KEYS, benchmarkLabel } from './bond-labels';
import { SecurityBondProgramCard } from './SecurityBondProgramCard';
import { SecurityBondScenarioPanel } from './SecurityBondScenarioPanel';
import { SecurityBondSeriesTable } from './SecurityBondSeriesTable';

interface SecurityBondCardProps {
  security: Security;
  /** Called after a recompute wrote or removed prices, so the page re-reads its quote. */
  onPricesChanged?: () => void | Promise<void>;
  /**
   * Bumped by the page each time a price refresh completes (whatever its
   * outcome): the bond data the refresh fetched is re-read once, in place.
   */
  refreshVersion?: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Each distinct entry once, in first-seen order. */
function distinct<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * The page of a program-linked security (spec `bond-program-securities.md`
 * 3.4), from the top: "Your series" (its lots valued on a day, one row per
 * series held), "The program" and "On sale now" for the program (the terms
 * history has its own tab). Shown only for a security with a `bondProgramId`;
 * the page decides that.
 *
 * The payload is kept with the request key that produced it (security and
 * day): while a different key is loading, the previous figures are not shown,
 * and a failed request is an error state, never an empty or zero valuation.
 */
export function SecurityBondCard({
  security,
  onPricesChanged,
  refreshVersion = 0,
}: SecurityBondCardProps) {
  const t = useTranslations('securityDetail');
  const { formatPercentTrimmed, formatShareQuantity } = useNumberFormat();
  const tInv = useTranslations('investments');
  const { formatDate } = useDateFormat();
  const today = useFinancialToday();
  // '' means "today", so a tab left open across midnight does not pin a day.
  const [pickedAsOf, setPickedAsOf] = useState('');
  const asOf = YMD.test(pickedAsOf) ? pickedAsOf : today;
  // The value the reader picked in the scenario panel; null is the engine's
  // default assumption (no `assume`). It belongs to one benchmark of one security.
  const [picked, setPicked] = useState<{
    securityId: string;
    benchmarkId: string;
    value: string;
  } | null>(null);
  const assume: BondAssumption | null =
    picked !== null && picked.securityId === security.id
      ? { benchmarkId: picked.benchmarkId, value: picked.value }
      : null;
  const requestKey = `${security.id}|${asOf}|${
    assume ? `${assume.benchmarkId}:${assume.value}` : ''
  }`;
  const [isRecomputing, setIsRecomputing] = useState(false);

  const { data, dataKey, isLoading, error, reload } =
    useReportData<SecurityBondValuation>(
      () =>
        investmentsApi.getSecurityBondValuation(
          security.id,
          asOf,
          assume ?? undefined,
        ),
      [security.id, asOf, assume?.benchmarkId, assume?.value, refreshVersion],
      { requestKey },
    );

  // The payload belongs to the request that produced it: anything else on hand
  // describes another security or day and is not shown as this one.
  const valuation = data !== null && dataKey === requestKey ? data : null;
  const currency = security.currencyCode;

  const handleRecompute = async () => {
    setIsRecomputing(true);
    try {
      const result = await investmentsApi.recomputeSecurityBondPrices(
        security.id,
      );
      toast.success(
        t('bond.recompute.done', {
          written: result.written,
          deleted: result.deleted,
        }),
      );
      reload();
      await onPricesChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err, t('bond.recompute.failed')));
    } finally {
      setIsRecomputing(false);
    }
  };

  // The newest answer for this security, whatever day it was asked for.
  const latest = data !== null && data.securityId === security.id ? data : null;
  // The lots grouped by the series they belong to; each row is one series.
  const heldSeries = useMemo(
    () => (valuation ? groupLotsBySeries(valuation) : []),
    [valuation],
  );
  // The program survives a reload of the valuation (another day, a retry), so
  // the sections under "Your series" do not blink away with it.
  const latestHeld = useMemo(
    () => (latest ? groupLotsBySeries(latest) : []),
    [latest],
  );

  const assumptions = useMemo(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.projectionAssumptions),
            (a) => `${a.benchmarkId}|${a.value}|${a.basis}|${a.observation ?? ''}`,
          )
        : [],
    [valuation],
  );
  const missing = useMemo<BondMissingObservation[]>(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.missing),
            (m) => `${m.benchmarkId}|${m.observation}|${m.publisher ?? ''}`,
          )
        : [],
    [valuation],
  );

  // A benchmark no future period can be projected from, each once.
  const projectionMissing = useMemo<BondProjectionMissing[]>(
    () =>
      valuation
        ? distinct(
            valuation.lots.flatMap((l) => l.valuation.projectionMissing ?? []),
            (m) => `${m.benchmarkId}|${m.publisher ?? ''}`,
          )
        : [],
    [valuation],
  );
  // `=== false` only: an absent flag is no information. Each cause is named.
  const incompleteLots = useMemo(
    () =>
      valuation
        ? valuation.lots.filter((l) => l.valuation.valuationComplete === false)
        : [],
    [valuation],
  );

  // Each cause once. A lot that is incomplete for a reason no flag names (a
  // refused purchase, a rate not known yet) is reported as "other".
  const partialCauses = useMemo(() => {
    const causes: Array<'terms' | 'reference' | 'earlyRedemption' | 'other'> = [];
    const has = (pick: (l: (typeof incompleteLots)[number]) => boolean) =>
      incompleteLots.some(pick);
    if (has((l) => l.valuation.dataCompleteness?.termsComplete === false)) {
      causes.push('terms');
    }
    if (has((l) => l.valuation.dataCompleteness?.referenceDataComplete === false)) {
      causes.push('reference');
    }
    if (
      has((l) => l.valuation.dataCompleteness?.earlyRedemptionTermsComplete === false)
    ) {
      causes.push('earlyRedemption');
    }
    const unexplained = (l: (typeof incompleteLots)[number]) => {
      const c = l.valuation.dataCompleteness;
      return (
        c?.termsComplete !== false &&
        c?.referenceDataComplete !== false &&
        c?.earlyRedemptionTermsComplete !== false
      );
    };
    if (has(unexplained)) causes.push('other');
    return causes;
  }, [incompleteLots]);

  // The action enum is shown by the investment screens' own translated name.
  const actionLabel = (action: string): string => {
    const key = ACTION_LABEL_KEYS[action];
    return key === undefined ? action : tInv(`transactionList.${key}`);
  };
  const benchmarkName = (id: string) => benchmarkLabel(t, id);
  // A step series is keyed by day, a monthly one by YYYY-MM (shown as is).
  const observationLabel = (key: string) => (YMD.test(key) ? formatDate(key) : key);

  const renderBody = () => {
    // A failed latest request is shown as one, whatever an earlier answer was.
    if (error) {
      return (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(error, t('bond.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t('error.retry')}
          </Button>
        </div>
      );
    }
    if (!valuation) {
      return (
        <div className="flex justify-center py-8">
          <LoadingSpinner text={t('bond.loading')} />
        </div>
      );
    }

    const { totals, refusal, lots } = valuation;
    const coverage = valuation.benchmarkCoverage ?? [];
    const totalReason = refusal
      ? t('bond.totals.unknownRefusal')
      : t('bond.totals.unknownLot');

    return (
      <div className="space-y-4" aria-busy={isLoading}>
        {incompleteLots.length > 0 && (
          <div
            role="note"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <p className="font-medium">{t('bond.partial.title')}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {partialCauses.map((cause) => (
                <li key={cause}>{t(`bond.partial.${cause}`)}</li>
              ))}
            </ul>
          </div>
        )}

        {valuation.marketPriceRequired === true && (
          <div
            role="note"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            {t('bond.marketPriceRequired')}
          </div>
        )}

        {refusal && (
          <div
            role="alert"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          >
            <p className="font-medium">
              {t(`bond.lotsRefusal.${refusal.code}`)}
            </p>
            <p className="mt-1">
              {t(`bond.lotsRefusalDetail.${refusal.code}`, {
                action: actionLabel(refusal.params.action),
                date: formatDate(refusal.params.date),
                quantity:
                  refusal.params.quantity === null
                    ? t('bond.unknown')
                    : formatShareQuantity(Number(refusal.params.quantity)),
              })}
            </p>
          </div>
        )}

        {!refusal && lots.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('bond.noLots')}
          </p>
        )}
        <SecurityBondSeriesTable
          series={heldSeries}
          totals={totals}
          currency={currency}
          unknownReason={totalReason}
        />

        {assumptions.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.assumptions.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {assumptions.map((a) => (
                <li
                  key={`${a.benchmarkId}|${a.value}|${a.basis}|${a.observation ?? ''}`}
                >
                  {a.basis === 'LATEST_OBSERVATION' && a.observation !== null
                    ? t('bond.assumptions.latestObservation', {
                        benchmark: benchmarkName(a.benchmarkId),
                        value: formatPercentTrimmed(Number(a.value) * 100),
                        observation: observationLabel(a.observation),
                      })
                    : t(
                        a.growth === 'SIMPLE_ANNUAL'
                          ? 'bond.assumptions.suppliedSimpleAnnual'
                          : 'bond.assumptions.supplied',
                        {
                          benchmark: benchmarkName(a.benchmarkId),
                          value: formatPercentTrimmed(Number(a.value) * 100),
                        },
                      )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {projectionMissing.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.projectionMissing.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {projectionMissing.map((m) => (
                <li key={`${m.benchmarkId}|${m.publisher ?? ''}`}>
                  {m.publisher === null
                    ? t('bond.projectionMissing.itemNoPublisher', {
                        benchmark: benchmarkName(m.benchmarkId),
                      })
                    : t('bond.projectionMissing.item', {
                        benchmark: benchmarkName(m.benchmarkId),
                        publisher: m.publisher,
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {missing.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.missing.title')}
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-400">
              {missing.map((m) => (
                <li key={`${m.benchmarkId}|${m.observation}|${m.publisher ?? ''}`}>
                  {m.publisher === null
                    ? t('bond.missing.itemNoPublisher', {
                        benchmark: benchmarkName(m.benchmarkId),
                        observation: observationLabel(m.observation),
                      })
                    : t('bond.missing.item', {
                        benchmark: benchmarkName(m.benchmarkId),
                        observation: observationLabel(m.observation),
                        publisher: m.publisher,
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {coverage.length > 0 && (
          <ul className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            {coverage.map((c) => (
              <li key={c.benchmarkId}>
                {c.coveredThrough === null
                  ? t('bond.coverage.none', {
                      benchmark: benchmarkName(c.benchmarkId),
                    })
                  : t('bond.coverage.asOf', {
                      benchmark: benchmarkName(c.benchmarkId),
                      date: formatDate(c.coveredThrough),
                    })}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  // The panel outlives a reload of the valuation it drives, so a click on a
  // scenario does not unmount the table it was clicked in. What it needs (the
  // benchmark the rule reads) is read from the newest answer for this security.
  // One benchmark drives the scenarios of the whole security: the first rule
  // among its lots that reads one (a series that does not read it is unchanged).
  const rule =
    latest === null
      ? null
      : (latest.lots
          .map((l) => l.valuation.rateRule)
          .find((r) => r.type !== 'FIXED') ??
        latest.lots[0]?.valuation.rateRule ??
        null);
  const scenarioBenchmark =
    rule !== null && rule.type !== 'FIXED' ? rule.benchmarkId : null;

  const seriesCard = (
    <Card padding="sm" aria-label={t('bond.series.title')} as="section">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('bond.series.title')}
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-44">
            <DateInput
              label={t('bond.asOf')}
              value={asOf}
              max={today}
              // The valuation refuses a day after today; a later date is
              // brought back to today rather than sent.
              onDateChange={(date) =>
                setPickedAsOf(YMD.test(date) && date > today ? today : date)
              }
            />
          </div>
          <Button
            variant="outline"
            onClick={handleRecompute}
            disabled={isRecomputing}
            isLoading={isRecomputing}
          >
            {t('bond.recompute.button')}
          </Button>
        </div>
      </div>
      {renderBody()}
      {rule !== null && scenarioBenchmark !== null && (
        <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
          <SecurityBondScenarioPanel
            securityId={security.id}
            benchmarkId={scenarioBenchmark}
            inflation={rule.type === 'INFLATION_PLUS_MARGIN_AS_RATE'}
            currency={currency}
            asOf={asOf}
            selected={assume ? assume.value : null}
            onSelect={(value) =>
              setPicked(
                value === null
                  ? null
                  : {
                      securityId: security.id,
                      benchmarkId: scenarioBenchmark,
                      value,
                    },
              )
            }
          />
        </div>
      )}
    </Card>
  );

  return (
    <div className="space-y-6">
      {seriesCard}
      {latest !== null && (
        <>
          <SecurityBondProgramCard
            security={security}
            programCode={latest.program.programCode}
            countryCode={latest.program.issuerCountryCode}
            held={latestHeld}
            autoFetch={latest.autoFetch}
            refreshVersion={refreshVersion}
          />
          <Card padding="sm" aria-label={t('bond.onSale.title')} as="section">
            <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('bond.onSale.title')}
            </h3>
            <BondOfferTab
              countryCode={latest.program.issuerCountryCode}
              programCode={latest.program.programCode}
              refreshVersion={refreshVersion}
            />
          </Card>
        </>
      )}
    </div>
  );
}
