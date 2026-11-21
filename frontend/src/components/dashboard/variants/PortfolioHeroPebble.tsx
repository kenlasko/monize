'use client';

import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { HeroFigureSkeleton, HeroHeadline } from '../hero-parts';
import { BlockFigure, PebbleChangePill } from './hero-statement-parts';
import type { PortfolioHeroViewProps } from './portfolio-hero-view';

/**
 * The portfolio set in the Pebble style, drawn inside the hero's inverted
 * block as the net worth set is (`NetWorthHeroPebble`): the value set huge in
 * the grotesque, the change as a pill, the three figures under it, and the
 * value chart beside it.
 */
export function PortfolioHeroPebble({
  label,
  currency,
  caption,
  total,
  collapsed,
  change,
  holdings,
  cash,
  metric,
  chart,
}: PortfolioHeroViewProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();
  return (
    <section aria-label={label} data-testid="dashboard-hero" className="flex flex-wrap gap-x-10 gap-y-7">
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col">
        <div className="font-semibold text-gray-500 dark:text-gray-400">{caption}</div>
        <div className="mt-1.5">
          <HeroHeadline
            negative={false}
            collapsed={collapsed}
            sizeClass="text-6xl sm:text-7xl xl:text-[92px] font-bold text-gray-900 dark:text-gray-50"
          >
            <PartialTotal total={total} displayCurrency={currency}>
              <MoneyFigure amount={total.value} currencyCode={currency} display />
            </PartialTotal>
          </HeroHeadline>
        </div>
        {change !== null &&
          (change.kind === 'known' ? (
            <PebbleChangePill up={change.up}>{change.text}</PebbleChangePill>
          ) : change.kind === 'unknown' ? (
            <PebbleChangePill up={null}>{change.text}</PebbleChangePill>
          ) : (
            <div className="mt-3.5 flex">
              <HeroFigureSkeleton width="w-40" />
            </div>
          ))}
        <dl className="mt-auto flex flex-wrap gap-x-9 gap-y-3 pt-7">
          <BlockFigure label={t('hero.holdingsLabel')}>
            <PartialTotal total={holdings} displayCurrency={currency}>
              {formatCurrency(holdings.value, currency)}
            </PartialTotal>
          </BlockFigure>
          <BlockFigure label={t('hero.cashLabel')}>
            <PartialTotal total={cash} displayCurrency={currency}>
              {formatCurrency(cash.value, currency)}
            </PartialTotal>
          </BlockFigure>
          <BlockFigure label={metric.label} testId="dashboard-hero-metric">
            {metric.value}
          </BlockFigure>
        </dl>
      </div>
      <div className="flex min-w-0 flex-[1_1_18rem] flex-col justify-end" data-testid="dashboard-hero-chart">
        <div className="h-60 w-full">{chart}</div>
      </div>
    </section>
  );
}
