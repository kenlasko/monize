'use client';

import type { ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';

/**
 * What the portfolio summary's headline shows, worked out once by
 * `PortfolioSummaryCard`. A style's variant only lays it out; it never reads
 * the summary or derives a figure.
 */
export interface PortfolioHeadlineViewProps {
  /** "Total Portfolio Value", or the subtotal's own name when it is one. */
  label: string;
  amount: number;
  /** The account's own currency, set only for a single foreign account. */
  foreignCurrency: string | null;
  /** The standard string, currency code included, as the page has always printed it. */
  valueText: string;
  /** The default-currency approximation line, when there is one. */
  approx: string | null;
  /** The gain over the holdings, already a partial's marker where it is one. */
  gain: {
    label: string;
    direction: 'up' | 'down' | 'flat';
    text: ReactNode;
  };
}

export function PortfolioHeadlineStandard({ label, valueText, approx }: PortfolioHeadlineViewProps) {
  return (
    <div>
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{valueText}</div>
      {approx !== null && (
        <div className="text-xs text-gray-400 dark:text-gray-500">{approx}</div>
      )}
    </div>
  );
}

/** The statement figure: small capitals over a serif total with a raised symbol. */
export function PortfolioHeadlineClassic({
  label,
  amount,
  foreignCurrency,
  approx,
}: PortfolioHeadlineViewProps) {
  return (
    <div className="ui-sum-headline" data-testid="portfolio-headline">
      <div className="ui-figure-label">{label}</div>
      <div className="mt-1 text-4xl text-gray-900 dark:text-gray-100">
        <MoneyFigure amount={amount} currencyCode={foreignCurrency ?? undefined} display />
        {foreignCurrency && (
          <span className="ml-2 text-base text-gray-500 dark:text-gray-400">{foreignCurrency}</span>
        )}
      </div>
      {approx !== null && (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{approx}</div>
      )}
    </div>
  );
}

/** The ink block: the value set huge, the gain over the holdings as a pill. */
export function PortfolioHeadlineModern({
  label,
  amount,
  foreignCurrency,
  approx,
  gain,
}: PortfolioHeadlineViewProps) {
  const tone =
    gain.direction === 'up'
      ? 'bg-green-400/15 text-green-400'
      : gain.direction === 'down'
        ? 'bg-red-400/15 text-red-400'
        : 'bg-gray-400/15 text-gray-400';
  return (
    <div
      className="ui-invert ui-ink-block ui-sum-headline mb-1"
      data-testid="portfolio-headline"
    >
      <div className="ui-figure-label">{label}</div>
      <div className="mt-1.5 text-5xl font-bold text-gray-900 dark:text-gray-50 sm:text-6xl">
        <MoneyFigure amount={amount} currencyCode={foreignCurrency ?? undefined} display />
        {foreignCurrency && (
          <span className="ml-2 text-lg font-semibold text-gray-500 dark:text-gray-400">
            {foreignCurrency}
          </span>
        )}
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-testid="portfolio-headline-pill"
          className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold ${tone}`}
        >
          {gain.direction === 'up' && <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          {gain.direction === 'down' && <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          {gain.text}
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400">{gain.label}</span>
      </div>
      {approx !== null && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{approx}</div>
      )}
    </div>
  );
}

const VARIANTS: StyleVariants<PortfolioHeadlineViewProps> = {
  standard: PortfolioHeadlineStandard,
  classic: PortfolioHeadlineClassic,
  modern: PortfolioHeadlineModern,
};

export function PortfolioHeadline(props: PortfolioHeadlineViewProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}
