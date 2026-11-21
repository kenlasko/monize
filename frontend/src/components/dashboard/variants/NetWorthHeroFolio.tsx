'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import type { ConvertedTotal } from '@/lib/currency-total';
import { HeroFigureSkeleton, HeroHeadline } from '../hero-parts';
import { NetWorthStepChart } from './NetWorthStepChart';
import type { NetWorthHeroViewProps } from './net-worth-hero-view';

/** One ruled cell of the statement's figures: a small-caps label over the amount. */
function StatementFigure({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`min-w-0 pt-3 ${
        first ? 'pr-3 sm:pr-4' : 'border-l border-gray-200 px-3 sm:px-4 dark:border-gray-700'
      }`}
    >
      <dt className="text-[11px] uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-[15px] text-gray-900 sm:text-lg dark:text-gray-100">{children}</dd>
    </div>
  );
}

function StatementAmount({
  total,
  currency,
  explanation,
}: {
  total: ConvertedTotal;
  currency: string;
  explanation?: string;
}) {
  return (
    <PartialTotal total={total} displayCurrency={currency} explanation={explanation}>
      <MoneyFigure amount={total.value} className="ui-money-quiet" />
    </PartialTotal>
  );
}

/** A small filled triangle, pointing the way net worth moved. */
function ChangeMark({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="flex-shrink-0">
      <path d={up ? 'M6 1 L11 9 H1 Z' : 'M6 11 L1 3 H11 Z'} fill="currentColor" />
    </svg>
  );
}

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
          <PartialTotal total={netWorth} displayCurrency={currency}>
            <MoneyFigure amount={netWorth.value} display />
          </PartialTotal>
        </HeroHeadline>
        {change !== null &&
          (change.known ? (
            <div
              data-testid="dashboard-hero-pill"
              className={`mt-1.5 flex items-center gap-2 font-medium ${
                change.up ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
              }`}
            >
              <ChangeMark up={change.up} />
              <span>{change.text}</span>
            </div>
          ) : (
            <div data-testid="dashboard-hero-pill" className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
              <UnknownAmount reason="displayFx" />
            </div>
          ))}
        <dl className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] border-t border-gray-200 dark:border-gray-700">
          <StatementFigure label={t('hero.assetsLabel')} first>
            <StatementAmount total={assets} currency={currency} />
          </StatementFigure>
          <StatementFigure label={t('hero.liabilitiesLabel')}>
            <StatementAmount total={liabilities} currency={currency} />
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
      <div
        className="h-56 w-full sm:h-64 lg:-mt-[var(--hero-head-h,0px)] lg:h-[17rem] lg:min-w-0 lg:flex-1"
        data-testid="dashboard-hero-chart"
      >
        <NetWorthStepChart
          points={points}
          currency={currency}
          formatTick={formatTick}
          formatTooltipKey={formatTooltipKey}
        />
      </div>
    </section>
  );
}
