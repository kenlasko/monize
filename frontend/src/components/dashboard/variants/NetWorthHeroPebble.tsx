'use client';

import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { HeroFigureSkeleton, HeroHeadline } from '../hero-parts';
import { BlockFigure, PebbleChangePill } from './hero-statement-parts';
import { MonthBars } from './MonthBars';
import type { NetWorthHeroViewProps } from './net-worth-hero-view';

/**
 * The net worth set in the Pebble style, drawn inside the hero's inverted
 * block (`DashboardHero`): net worth set huge in the grotesque, the month's
 * move as a pill, the three figures under it, and a bar per month beside it
 * with the current month in the accent.
 */
export function NetWorthHeroPebble({
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
  formatNarrowMonth,
}: NetWorthHeroViewProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();
  return (
    <section aria-label={label} data-testid="dashboard-hero" className="flex flex-wrap gap-x-10 gap-y-7">
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col">
        <div className="font-semibold text-gray-500 dark:text-gray-400">{t('hero.netWorth')}</div>
        <div className="mt-1.5">
          <HeroHeadline
            negative={false}
            collapsed={collapsed}
            sizeClass="text-6xl sm:text-7xl xl:text-[92px] font-bold text-gray-900 dark:text-gray-50"
          >
            <PartialTotal total={netWorth} displayCurrency={currency}>
              <MoneyFigure amount={netWorth.value} display />
            </PartialTotal>
          </HeroHeadline>
        </div>
        {change !== null &&
          (change.known ? (
            <PebbleChangePill up={change.up}>{change.text}</PebbleChangePill>
          ) : (
            <PebbleChangePill up={null}>
              <UnknownAmount reason="displayFx" />
            </PebbleChangePill>
          ))}
        <dl className="mt-auto flex flex-wrap gap-x-9 gap-y-3 pt-7">
          <BlockFigure label={t('hero.assetsLabel')}>
            <PartialTotal total={assets} displayCurrency={currency}>
              {formatCurrency(assets.value)}
            </PartialTotal>
          </BlockFigure>
          <BlockFigure label={t('hero.liabilitiesLabel')}>
            <PartialTotal total={liabilities} displayCurrency={currency}>
              {formatCurrency(liabilities.value)}
            </PartialTotal>
          </BlockFigure>
          {(investedLoading || invested) && (
            <BlockFigure label={t('hero.investedLabel')}>
              {invested ? (
                <PartialTotal total={invested.total} displayCurrency={currency} explanation={invested.explanation}>
                  {formatCurrency(invested.value)}
                </PartialTotal>
              ) : (
                <HeroFigureSkeleton />
              )}
            </BlockFigure>
          )}
        </dl>
      </div>
      <div className="flex min-w-0 flex-[1_1_18rem] flex-col justify-end" data-testid="dashboard-hero-chart">
        <MonthBars points={points} currency={currency} formatNarrowMonth={formatNarrowMonth} />
      </div>
    </section>
  );
}
