'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import {
  HeroAreaChart,
  HeroCaption,
  HeroFigureSkeleton,
  HeroHeadline,
  HeroLayout,
  HeroPill,
  HeroPillUnknown,
  HeroSubFigures,
  heroStrong,
} from '../hero-parts';
import type { NetWorthHeroViewProps } from './net-worth-hero-view';

/** The net worth set in the Standard style: the figures beside an area chart. */
export function NetWorthHeroStandard({
  label,
  currency,
  netWorth,
  assets,
  liabilities,
  invested,
  investedLoading,
  collapsed,
  change,
  points,
  formatTick,
  formatTooltipKey,
}: NetWorthHeroViewProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();

  const pill =
    change === null ? null : change.known ? (
      <HeroPill up={change.up}>{change.text}</HeroPill>
    ) : (
      <HeroPillUnknown>
        <UnknownAmount reason="displayFx" />
      </HeroPillUnknown>
    );

  return (
    <HeroLayout
      label={label}
      figures={
        <>
          <HeroCaption>{t('hero.netWorth')}</HeroCaption>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <HeroHeadline negative={netWorth.value < 0} collapsed={collapsed}>
              <PartialTotal total={netWorth} displayCurrency={currency}>
                {formatCurrency(netWorth.value)}
              </PartialTotal>
            </HeroHeadline>
            {pill}
          </div>
          <HeroSubFigures>
            <span>
              {t.rich('hero.assets', {
                value: () => (
                  <PartialTotal total={assets} displayCurrency={currency}>
                    {formatCurrency(assets.value)}
                  </PartialTotal>
                ),
                strong: heroStrong,
              })}
            </span>
            <span>
              {t.rich('hero.liabilities', {
                value: () => (
                  <PartialTotal total={liabilities} displayCurrency={currency}>
                    {formatCurrency(liabilities.value)}
                  </PartialTotal>
                ),
                strong: heroStrong,
              })}
            </span>
            {investedLoading && <HeroFigureSkeleton />}
            {!investedLoading && invested && (
              <span>
                {t.rich('hero.invested', {
                  value: () => (
                    <PartialTotal total={invested.total} displayCurrency={currency} explanation={invested.explanation}>
                      {formatCurrency(invested.value)}
                    </PartialTotal>
                  ),
                  strong: heroStrong,
                })}
              </span>
            )}
          </HeroSubFigures>
        </>
      }
      chart={
        <HeroAreaChart
          points={points}
          currency={currency}
          gradientId="dashboardHeroNetWorth"
          formatTick={formatTick}
          formatTooltipKey={formatTooltipKey}
        />
      }
    />
  );
}

