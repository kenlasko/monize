'use client';

import { PartialTotal } from '@/components/ui/PartialTotal';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { useTranslations } from 'next-intl';
import { HeroFigureSkeleton, HeroHeadline } from '../hero-parts';
import { FolioChangeLine, StatementAmount, StatementFigure } from './hero-statement-parts';
import type { PortfolioHeroViewProps } from './portfolio-hero-view';

/**
 * The portfolio set in the Folio style, set as the net worth set is
 * (`NetWorthHeroFolio`): the value large in the serif with its cents set back,
 * the change under it, the three figures in ruled cells, and the value chart
 * rising beside the greeting at the same height.
 */
export function PortfolioHeroFolio({
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
  return (
    <section
      aria-label={label}
      data-testid="dashboard-hero"
      className="flex flex-col gap-x-14 gap-y-4 lg:flex-row lg:items-start"
    >
      <div className="flex flex-col gap-1.5 lg:min-w-[max(var(--hero-figures-min,0px),27rem)] lg:flex-shrink-0">
        <div className="mt-4 text-xs uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">{caption}</div>
        <HeroHeadline
          negative={total !== null && total.value < 0}
          collapsed={collapsed}
          sizeClass="text-6xl sm:text-7xl lg:text-[84px] font-medium"
        >
          {total === null ? (
            unknown
          ) : (
            <PartialTotal total={total} displayCurrency={currency}>
              <MoneyFigure amount={total.value} currencyCode={currency} display />
            </PartialTotal>
          )}
        </HeroHeadline>
        {change !== null &&
          (change.kind === 'known' ? (
            <FolioChangeLine up={change.up}>{change.text}</FolioChangeLine>
          ) : change.kind === 'unknown' ? (
            <FolioChangeLine up={null}>{change.text}</FolioChangeLine>
          ) : (
            <div className="mt-1.5">
              <HeroFigureSkeleton width="w-40" />
            </div>
          ))}
        <dl className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] border-t border-gray-200 dark:border-gray-700">
          <StatementFigure label={t('hero.holdingsLabel')} first>
            {holdings === null ? unknown : <StatementAmount total={holdings} currency={currency} />}
          </StatementFigure>
          <StatementFigure label={t('hero.cashLabel')}>
            {cash === null ? unknown : <StatementAmount total={cash} currency={currency} />}
          </StatementFigure>
          <StatementFigure label={metric.label} testId="dashboard-hero-metric">
            {metric.value}
          </StatementFigure>
        </dl>
      </div>
      {/* Stacked, a fixed height. Beside the figures there is none: the box
          stretches to the figures' height and, its top margin pulling it up past
          the greeting row, rises to the top of the hero, so it neither stops short
          of the figures' bottom nor leaves space above them. The chart is
          absolutely placed so only the figures set the row's height. */}
      <div
        className="relative h-64 w-full sm:h-72 lg:-mt-[var(--hero-head-h,0px)] lg:h-auto lg:min-w-0 lg:flex-1 lg:self-stretch"
        data-testid="dashboard-hero-chart"
      >
        <div className="absolute inset-0">{chart}</div>
      </div>
    </section>
  );
}
