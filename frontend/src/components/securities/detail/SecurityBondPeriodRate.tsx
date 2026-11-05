'use client';

import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type {
  BondRateScheduleEntry,
  BondRateSource,
  BondValuation,
} from '@/types/bond';
import { benchmarkLabel } from './bond-labels';

export const RATE_SOURCE_VARIANT: Record<BondRateSource, BadgeVariant> = {
  TERMS: 'blue',
  ANNOUNCED: 'green',
  DERIVED: 'gray',
  PROJECTED: 'amber',
};

interface SecurityBondPeriodRateProps {
  valuation: BondValuation;
  /** The period asked about: the lot's current period or one entry of its schedule. */
  period: Pick<BondRateScheduleEntry, 'index' | 'annualRate' | 'rateSource'>;
  /** List the runs of a floating period's daily rates instead of one line. */
  detail?: boolean;
  /** Say where the rate comes from beside it (a table with a source column of its own says false). */
  withSource?: boolean;
}

/**
 * The rate of one period, by what the terms' rate rule says it is: a stated
 * annual rate, the discount of a bill, or the daily rates of a floating note.
 * A period whose rate really is not known reads as unknown; one that has no
 * annual rate by design never does (the lot tables, the series table and the
 * rate section all read it here).
 */
export function SecurityBondPeriodRate({
  valuation,
  period,
  detail = false,
  withSource = true,
}: SecurityBondPeriodRateProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatPercentTrimmed } = useNumberFormat();
  // Rates are fractions; the formatter takes percent units.
  const pct = (fraction: string) => formatPercentTrimmed(Number(fraction) * 100);
  const muted = 'text-gray-500 dark:text-gray-400';
  const unknown = <span className={muted}>{t('bond.unknown')}</span>;
  const source =
    period.rateSource === null || !withSource ? null : (
      <Badge variant={RATE_SOURCE_VARIANT[period.rateSource]}>
        {t(`bond.rateSource.${period.rateSource}`)}
      </Badge>
    );

  if (period.annualRate !== null) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>{pct(period.annualRate)}</span>
        {source}
      </span>
    );
  }

  const rule = valuation.rateRule;
  if (rule.type === 'ZERO_COUPON_DISCOUNT') {
    return <span>{t('bond.rate.rule.discount')}</span>;
  }
  if (rule.type !== 'DAILY_INDEX_PLUS_SPREAD' || rule.benchmarkId === null) {
    return unknown;
  }

  const benchmark = benchmarkLabel(t, rule.benchmarkId);
  const runs =
    valuation.rateSchedule.find((entry) => entry.index === period.index)
      ?.dailyRates ?? [];
  if (!detail || runs.length === 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>
          {runs.length === 0
            ? t('bond.rate.dailyNoIndex', { benchmark })
            : t('bond.rate.daily', { benchmark })}
        </span>
        {source}
      </span>
    );
  }
  return (
    <ul className="space-y-0.5 whitespace-normal text-sm">
      {runs.map((run) => (
        <li key={run.from} className="inline-flex flex-wrap items-center gap-2">
          <span>
            {t('bond.rate.dailyRun', {
              from: formatDate(run.from),
              rate: pct(run.rate),
            })}
          </span>
          {run.projected && (
            <Badge variant="amber">{t('bond.lots.projected')}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
