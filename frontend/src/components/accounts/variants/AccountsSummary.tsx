'use client';

import { useUiStyle, renderForStyle } from '@/hooks/useUiStyle';
import type { AccountsSummaryViewProps } from './accounts-summary-view';

export function AccountsSummaryStandard({ children }: AccountsSummaryViewProps) {
  return <>{children}</>;
}

/**
 * Folio: a statement head. Net worth is the headline figure on the left,
 * the assets, liabilities and account count are ruled lines on the right, as
 * the foot of a statement of accounts.
 */
export function AccountsSummaryFolio({
  accountCount,
  netWorth,
  assets,
  liabilities,
  netWorthNegative,
  labels,
}: AccountsSummaryViewProps) {
  return (
    <div data-testid="accounts-summary-statement" className="ui-acc-statement grid gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div>
        <div className="ui-figure-label">{labels.netWorth}</div>
        <div
          className={`ui-display-figure mt-1 text-5xl ${
            netWorthNegative ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-50'
          }`}
        >
          {netWorth}
        </div>
      </div>
      <dl className="ui-acc-statement-lines">
        <div className="ui-acc-statement-line">
          <dt>{labels.assets}</dt>
          <dd className="ui-display-figure text-gray-900 dark:text-gray-100">{assets}</dd>
        </div>
        <div className="ui-acc-statement-line">
          <dt>{labels.liabilities}</dt>
          <dd className="ui-display-figure text-gray-900 dark:text-gray-100">{liabilities}</dd>
        </div>
        <div className="ui-acc-statement-line">
          <dt>{labels.accounts}</dt>
          <dd className="ui-display-figure text-gray-900 dark:text-gray-100">{accountCount}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Pebble: net worth set huge in an ink block, the assets and the liabilities
 * as two white blocks beside it, the account count a pill in the ink block.
 */
export function AccountsSummaryPebble({
  accountCount,
  netWorth,
  assets,
  liabilities,
  labels,
}: AccountsSummaryViewProps) {
  return (
    <div data-testid="accounts-summary-blocks" className="flex flex-wrap gap-4">
      <div className="ui-invert min-w-0 flex-[2_1_22rem] rounded-[28px] bg-white p-6 text-gray-900 sm:p-8 dark:bg-gray-800 dark:text-gray-100">
        <div className="ui-figure-label">{labels.netWorth}</div>
        <div className="ui-display-figure mt-1.5 text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl dark:text-gray-50">
          {netWorth}
        </div>
        <span className="mt-4 inline-flex rounded-full bg-gray-100 px-3.5 py-1.5 text-sm font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
          {labels.accounts}: {accountCount}
        </span>
      </div>
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-4">
        <div className="ui-block-accent flex-1 rounded-[28px] p-5 sm:p-6">
          <div className="ui-figure-label !text-inherit opacity-80">{labels.assets}</div>
          <div className="ui-display-figure mt-1 text-3xl font-bold tracking-tight">{assets}</div>
        </div>
        <div className="ui-card flex-1 rounded-[28px] bg-white p-5 sm:p-6 dark:bg-gray-800">
          <div className="ui-figure-label">{labels.liabilities}</div>
          <div className="ui-display-figure mt-1 text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
            {liabilities}
          </div>
        </div>
      </div>
    </div>
  );
}

const VARIANTS = {
  standard: AccountsSummaryStandard,
  folio: AccountsSummaryFolio,
  pebble: AccountsSummaryPebble,
};

export function AccountsSummary(props: AccountsSummaryViewProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}
