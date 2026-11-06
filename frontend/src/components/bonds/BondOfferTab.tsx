'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { NumericInput } from '@/components/ui/NumericInput';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { TABLE_BODY_CLASS, TABLE_CLASS, TH_CLASS, Td, Th } from '@/components/ui/Table';
import { benchmarkLabel, programLabel } from '@/components/securities/detail/bond-labels';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { getErrorMessage } from '@/lib/errors';
import { toSafeExternalUrl } from '@/lib/external-url';
import { investmentsApi } from '@/lib/investments';
import {
  ASSUMPTION_MAX_PERCENT,
  ASSUMPTION_MIN_PERCENT,
  buildAssumptions,
  fractionToPercent,
  offerBenchmarks,
  offerFirstPeriodRate,
  offerLengthMonths,
  sortOffer,
  type OfferSortDirection,
  type OfferSortField,
} from '@/lib/bond-offer';
import type { BondOffer, OfferSeries } from '@/types/bond';

interface BondOfferTabProps {
  /** The issuing country of the bond's program; the offer is read for it. */
  countryCode: string;
  /** Only the series of this program are listed; every program when omitted. */
  programCode?: string;
  /** Bumped by the page when a price refresh completes: re-reads in place. */
  refreshVersion?: number;
}

interface LatestObservation {
  /** A fraction string. */
  value: string;
  /** YYYY-MM or YYYY-MM-DD; null is never stored here. */
  observation: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ASSUMPTION_DEBOUNCE_MS = 500;

/**
 * The bonds on sale today, side by side (spec `bond-offer-and-history.md` 5).
 *
 * The inputs hold the benchmark values the rows read: prefilled with the latest
 * published value and its month, and a value the reader types is sent as an
 * `assume` after a pause. The table shows only the answer to the assumptions in
 * force; while a newer typed value is still on its way the rows are dimmed
 * rather than passed off as that value's figures. A figure that rests on an
 * assumption wears the "Projected" badge; one the engine cannot value is
 * unknown, with the reason beside it, never a zero.
 */
export function BondOfferTab({ countryCode, programCode, refreshVersion = 0 }: BondOfferTabProps) {
  const t = useTranslations('bonds');
  const tSec = useTranslations('securityDetail');
  const { formatDate, formatMonth } = useDateFormat();
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();

  // The percents the reader typed, by benchmark. A key holding undefined is a
  // field the reader cleared: nothing is sent for it.
  const [typed, setTyped] = useState<Record<string, number | undefined>>({});
  const [sort, setSort] = useState<{
    field: OfferSortField;
    direction: OfferSortDirection;
  }>({ field: 'annualizedReturn', direction: 'desc' });
  // The latest published value of each benchmark, kept from the answers that
  // carried it: once the reader supplies a value the response no longer says so.
  const [latest, setLatest] = useState<Record<string, LatestObservation>>({});

  const sentTyped = useDebouncedValue(typed, ASSUMPTION_DEBOUNCE_MS);
  const sent = useMemo(() => buildAssumptions(sentTyped), [sentTyped]);
  const wanted = useMemo(() => buildAssumptions(typed), [typed]);
  const keyOf = (list: ReadonlyArray<{ benchmarkId: string; value: string }>) =>
    list.map((a) => `${a.benchmarkId}:${a.value}`).join(',');
  const requestKey = `${countryCode}|${keyOf(sent)}`;
  const isPending = keyOf(wanted) !== keyOf(sent);

  const { data, dataKey, isLoading, error, reload } = useReportData<BondOffer>(
    () => investmentsApi.getBondOffer(countryCode, sent),
    [requestKey, refreshVersion],
    { requestKey },
  );

  // Remember each latest observation the answer carries (render-time update:
  // setState in an effect is banned here).
  if (data !== null) {
    const merged: Record<string, LatestObservation> = { ...latest };
    let changed = false;
    for (const series of data.series) {
      for (const a of series.projection.assumptions) {
        if (a.basis !== 'LATEST_OBSERVATION' || a.observation === null) continue;
        const known = merged[a.benchmarkId];
        if (known?.value === a.value && known.observation === a.observation) continue;
        merged[a.benchmarkId] = { value: a.value, observation: a.observation };
        changed = true;
      }
    }
    if (changed) setLatest(merged);
  }

  // What is on screen is the answer to the question asked, never another one's.
  const offer = data !== null && dataKey === requestKey ? data : null;
  const benchmarks = useMemo(
    () =>
      data === null
        ? []
        : offerBenchmarks(
            programCode === undefined
              ? data.series
              : data.series.filter((s) => s.programCode === programCode),
          ),
    [data, programCode],
  );
  const rows = useMemo(
    () =>
      offer === null
        ? []
        : sortOffer(
            programCode === undefined
              ? offer.series
              : offer.series.filter((s) => s.programCode === programCode),
            sort.field,
            sort.direction,
          ),
    [offer, sort, programCode],
  );
  const hasCoupons = rows.some((s) => s.capitalization === 'NONE' && s.periodCount > 1);

  const handleSort = (field: OfferSortField) =>
    setSort((prev) =>
      prev.field === field
        ? { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: field === 'length' ? 'asc' : 'desc' },
    );

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">{tSec('bond.unknown')}</span>
  );
  const rate = (fraction: string | null): ReactNode =>
    fraction === null ? unknown : formatPercentTrimmed(Number(fraction) * 100);
  const observationLabel = (key: string) =>
    YMD.test(key) ? formatDate(key) : formatMonth(key);

  const projectedBadge = (series: OfferSeries): ReactNode =>
    series.projection.projected ? (
      <Badge variant="amber" className="mt-1" title={t('offer.projectedTitle')}>
        {t('offer.projected')}
      </Badge>
    ) : null;

  const renderRule = (series: OfferSeries): ReactNode => {
    const { rateRule } = series;
    if (rateRule.type === 'ZERO_COUPON_DISCOUNT') return t('offer.rule.discount');
    if (rateRule.type === 'FIXED') {
      return rateRule.annualRate === null
        ? unknown
        : t('offer.rule.fixed', { rate: formatPercentTrimmed(Number(rateRule.annualRate) * 100) });
    }
    return (
      <>
        {t(rateRule.type === 'DAILY_INDEX_PLUS_SPREAD' ? 'offer.rule.daily' : 'offer.rule.benchmark', {
          benchmark:
            rateRule.benchmarkId === null ? '' : benchmarkLabel(tSec, rateRule.benchmarkId),
          addend:
            rateRule.addend === null ? '' : formatPercentTrimmed(Number(rateRule.addend) * 100),
        })}
        {rateRule.benchmarkFloor !== null && (
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t('offer.rule.floor', {
              floor: formatPercentTrimmed(Number(rateRule.benchmarkFloor) * 100),
            })}
          </span>
        )}
      </>
    );
  };

  const renderRedemption = (series: OfferSeries): ReactNode => {
    const { redemption } = series;
    if (redemption === null) return t('offer.redemption.none');
    return (
      <>
        {t('offer.redemption.onDemand')}
        {redemption.penalties.map((p) => (
          <span
            key={p.type}
            className="block whitespace-normal text-xs text-gray-500 dark:text-gray-400"
          >
            {p.type === 'FIXED_FEE_PER_UNIT'
              ? t('offer.redemption.fee', {
                  amount: formatCurrency(Number(p.amount), series.currency),
                })
              : t('offer.redemption.forfeit')}
          </span>
        ))}
      </>
    );
  };

  const renderFigure = (
    series: OfferSeries,
    value: string | null,
    format: (v: string) => string,
  ): ReactNode => {
    if (value === null) {
      return (
        <>
          {unknown}
          {series.projection.projectionMissing.map((m) => (
            <span
              key={m.benchmarkId}
              className="block whitespace-normal text-xs text-gray-500 dark:text-gray-400"
            >
              {m.publisher === null
                ? tSec('bond.projectionMissing.itemNoPublisher', {
                    benchmark: benchmarkLabel(tSec, m.benchmarkId),
                  })
                : tSec('bond.projectionMissing.item', {
                    benchmark: benchmarkLabel(tSec, m.benchmarkId),
                    publisher: m.publisher,
                  })}
            </span>
          ))}
        </>
      );
    }
    return (
      <>
        {format(value)}
        {projectedBadge(series)}
      </>
    );
  };

  const renderAssumptions = () => {
    if (benchmarks.length === 0) return null;
    const hasTyped = Object.keys(typed).length > 0;
    return (
      <section aria-label={t('offer.assumptions.title')} className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('offer.assumptions.title')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('offer.assumptions.intro')}
        </p>
        <div className="flex flex-wrap items-start gap-4">
          {benchmarks.map((id) => {
            const seen = latest[id];
            const value =
              id in typed ? typed[id] : seen ? fractionToPercent(seen.value) : undefined;
            return (
              <div key={id} className="w-full sm:w-64">
                <NumericInput
                  label={t('offer.assumptions.label', { benchmark: benchmarkLabel(tSec, id) })}
                  suffix="%"
                  value={value}
                  onChange={(v) => setTyped((prev) => ({ ...prev, [id]: v }))}
                  decimalPlaces={2}
                  allowNegative
                  min={ASSUMPTION_MIN_PERCENT}
                  max={ASSUMPTION_MAX_PERCENT}
                />
                {seen && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('offer.assumptions.latest', {
                      value: formatPercentTrimmed(Number(seen.value) * 100),
                      observation: observationLabel(seen.observation),
                    })}
                  </p>
                )}
              </div>
            );
          })}
          {hasTyped && (
            <Button variant="outline" className="sm:mt-6" onClick={() => setTyped({})}>
              {t('offer.assumptions.reset')}
            </Button>
          )}
        </div>
      </section>
    );
  };

  const renderTable = () => {
    if (rows.length === 0) {
      return <EmptyState title={t('offer.empty')} />;
    }
    return (
      <div className="overflow-x-auto scrollbar-slim" aria-busy={isPending || isLoading}>
        <table className={`${TABLE_CLASS} ${isPending ? 'opacity-60' : ''}`}>
          <thead>
            <tr>
              <Th>{t('offer.columns.series')}</Th>
              <Th>{t('offer.columns.saleWindow')}</Th>
              <SortableHeader
                field="length"
                sortField={sort.field}
                sortDirection={sort.direction}
                onSort={handleSort}
                className={TH_CLASS}
              >
                {t('offer.columns.length')}
              </SortableHeader>
              <SortableHeader
                field="firstPeriodRate"
                sortField={sort.field}
                sortDirection={sort.direction}
                onSort={handleSort}
                className={TH_CLASS}
              >
                {t('offer.columns.firstPeriodRate')}
              </SortableHeader>
              <Th>{t('offer.columns.rule')}</Th>
              <Th>{t('offer.columns.capitalization')}</Th>
              <Th>{t('offer.columns.redemption')}</Th>
              <Th align="right">{t('offer.columns.maturityValue')}</Th>
              <Th align="right">{t('offer.columns.totalReturn')}</Th>
              <SortableHeader
                field="annualizedReturn"
                sortField={sort.field}
                sortDirection={sort.direction}
                onSort={handleSort}
                align="right"
                className={TH_CLASS}
              >
                {t('offer.columns.annualizedReturn')}
              </SortableHeader>
              <Th>{t('offer.columns.terms')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {rows.map((series) => (
              <tr key={series.instrumentId}>
                <Td className="font-medium">
                  {series.seriesCode}
                  <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                    {programLabel(tSec, series.programCode)}
                  </span>
                </Td>
                <Td>
                  {t('offer.saleWindowValue', {
                    from: formatDate(series.saleWindow.from),
                    to: formatDate(series.saleWindow.to),
                  })}
                </Td>
                <Td className="whitespace-nowrap">
                  {series.lengthDays !== null
                    ? t('offer.lengthDaysValue', { days: series.lengthDays })
                    : t('offer.lengthValue', { months: offerLengthMonths(series) })}
                </Td>
                <Td className="whitespace-nowrap">{rate(offerFirstPeriodRate(series))}</Td>
                <Td>{renderRule(series)}</Td>
                <Td>{t(`offer.capitalization.${series.capitalization}`)}</Td>
                <Td>{renderRedemption(series)}</Td>
                <Td align="right" className="whitespace-nowrap">
                  {renderFigure(series, series.projection.maturityValue, (v) =>
                    formatCurrency(Number(v), series.currency),
                  )}
                  {series.capitalization === 'NONE' && series.periodCount > 1 && (
                    <span className="block whitespace-normal text-xs text-gray-500 dark:text-gray-400">
                      {t('offer.couponsNotReinvested')}
                    </span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {renderFigure(series, series.projection.totalReturn, (v) =>
                    formatPercentTrimmed(Number(v) * 100),
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap font-medium">
                  {renderFigure(series, series.projection.annualizedReturn, (v) =>
                    formatPercentTrimmed(Number(v) * 100),
                  )}
                </Td>
                <Td>
                  {toSafeExternalUrl(series.termsSource.url) ? (
                    <a
                      href={series.termsSource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {tSec('bond.termsSource', { document: series.termsSource.document })}
                    </a>
                  ) : (
                    tSec('bond.termsSource', { document: series.termsSource.document })
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  if (error && data === null) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(error, t('offer.loadFailed'))}
        </p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('offer.retry')}
        </Button>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner text={t('offer.loading')} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('offer.asOf', { date: formatDate(data.today) })}
      </p>
      {renderAssumptions()}
      {/* A failed re-query is said to be one; the rows below are not its answer. */}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(error, t('offer.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t('offer.retry')}
          </Button>
        </div>
      )}
      {offer === null && !error ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner text={t('offer.assumptions.updating')} />
        </div>
      ) : (
        offer !== null && renderTable()
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('offer.comparisonNote')}</p>
      {hasCoupons && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('offer.couponsNote')}</p>
      )}
    </div>
  );
}
