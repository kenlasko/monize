'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { PartialTotal } from '@/components/ui/PartialTotal';
import {
  HeroCaption,
  HeroFigureSkeleton,
  HeroHeadline,
  HeroLayout,
  HeroPill,
  HeroPillUnknown,
  HeroSubFigures,
  heroStrong,
} from '../hero-parts';
import type { PortfolioHeroViewProps } from './portfolio-hero-view';

/** The portfolio set in the Standard style: the figures beside an area chart. */
export function PortfolioHeroStandard({
  label,
  currency,
  caption,
  total,
  collapsed,
  change,
  holdings,
  cash,
  unknown,
  metric,
  chart,
}: PortfolioHeroViewProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();

  const pill =
    change === null ? null : change.kind === 'known' ? (
      <HeroPill up={change.up}>{change.text}</HeroPill>
    ) : change.kind === 'unknown' ? (
      <HeroPillUnknown>{change.text}</HeroPillUnknown>
    ) : (
      <HeroFigureSkeleton width="w-40" />
    );

  return (
    <HeroLayout
      label={label}
      figures={
        <>
          <HeroCaption>{caption}</HeroCaption>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <HeroHeadline negative={total !== null && total.value < 0} collapsed={collapsed}>
              {total === null ? (
                unknown.total
              ) : (
                <PartialTotal total={total} displayCurrency={currency}>
                  {formatCurrency(total.value, currency)}
                </PartialTotal>
              )}
            </HeroHeadline>
            {pill}
          </div>
          <HeroSubFigures>
            <span>
              {t.rich('hero.holdings', {
                value: () =>
                  holdings === null ? (
                    unknown.holdings
                  ) : (
                    <PartialTotal total={holdings} displayCurrency={currency}>
                      {formatCurrency(holdings.value, currency)}
                    </PartialTotal>
                  ),
                strong: heroStrong,
              })}
            </span>
            <span>
              {t.rich('hero.cash', {
                value: () =>
                  cash === null ? (
                    unknown.cash
                  ) : (
                    <PartialTotal total={cash} displayCurrency={currency}>
                      {formatCurrency(cash.value, currency)}
                    </PartialTotal>
                  ),
                strong: heroStrong,
              })}
            </span>
            <span data-testid="dashboard-hero-metric">
              {t.rich('hero.metricLine', {
                value: () => <>{metric.value}</>,
                metric: metric.name,
                strong: heroStrong,
              })}
            </span>
          </HeroSubFigures>
        </>
      }
      chart={chart}
    />
  );
}
