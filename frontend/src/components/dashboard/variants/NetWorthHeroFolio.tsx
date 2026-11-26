'use client';

import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { HeroFigureSkeleton, HeroHeadline } from '../hero-parts';
import { FolioChangeLine, StatementAmount, StatementFigure } from './hero-statement-parts';
import { NetWorthStepChart } from './NetWorthStepChart';
import type { NetWorthHeroViewProps } from './net-worth-hero-view';

/**
 * The net worth set in the Folio style, the dashboard as a statement: the
 * net worth set large in the serif with its cents set back, the month's move
 * under it, the three figures in ruled cells, and the history as a stepped
 * line rising beside the greeting.
 */
export function NetWorthHeroFolio({
  label,
  currency,
  netWorth,
  assets,
  liabilities,
  provisional,
  invested,
  investedLoading,
  collapsed,
  change,
  points,
  formatTick,
  formatTooltipKey,
}: NetWorthHeroViewProps) {
  const t = useTranslations('dashboard');
  return (
    <section
      aria-label={label}
      data-testid="dashboard-hero"
      className="flex flex-col gap-x-14 gap-y-4 lg:flex-row lg:items-start"
    >
      <div className="flex flex-col gap-1.5 lg:min-w-[max(var(--hero-figures-min,0px),27rem)] lg:flex-shrink-0">
        <div className="mt-4 text-xs uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">
          {t('hero.netWorth')}
        </div>
        <HeroHeadline
          negative={netWorth.value < 0}
          collapsed={collapsed}
          sizeClass="text-6xl sm:text-7xl lg:text-[84px] font-medium"
        >
          <PartialTotal total={netWorth} displayCurrency={currency} provisionalCount={provisional.netWorth}>
            <MoneyFigure amount={netWorth.value} display />
          </PartialTotal>
        </HeroHeadline>
        {change !== null &&
          (change.known ? (
            <FolioChangeLine up={change.up}>{change.text}</FolioChangeLine>
          ) : (
            <FolioChangeLine up={null}>
              <UnknownAmount reason="displayFx" />
            </FolioChangeLine>
          ))}
        <dl className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] border-t border-gray-200 dark:border-gray-700">
          <StatementFigure label={t('hero.assetsLabel')} first>
            <StatementAmount total={assets} currency={currency} provisionalCount={provisional.assets} />
          </StatementFigure>
          <StatementFigure label={t('hero.liabilitiesLabel')}>
            <StatementAmount total={liabilities} currency={currency} provisionalCount={provisional.liabilities} />
          </StatementFigure>
          {(investedLoading || invested) && (
            <StatementFigure label={t('hero.investedLabel')}>
              {invested ? (
                <StatementAmount total={invested.total} currency={currency} explanation={invested.explanation} />
              ) : (
                <HeroFigureSkeleton />
              )}
            </StatementFigure>
          )}
        </dl>
      </div>
      {/* Stacked, a fixed height. Beside the figures there is none: the box
          stretches to the figures' height and, its top margin pulling it up past
          the greeting row, rises to the top of the hero, so it neither stops short
          of the figures' bottom nor leaves space below the chart. The chart is
          absolutely placed so only the figures set the row's height. */}
      <div
        className="relative h-64 w-full sm:h-72 lg:-mt-[var(--hero-head-h,0px)] lg:h-auto lg:min-w-0 lg:flex-1 lg:self-stretch"
        data-testid="dashboard-hero-chart"
      >
        <div className="absolute inset-0">
          <NetWorthStepChart
            points={points}
            currency={currency}
            formatTick={formatTick}
            formatTooltipKey={formatTooltipKey}
          />
        </div>
      </div>
    </section>
  );
}
