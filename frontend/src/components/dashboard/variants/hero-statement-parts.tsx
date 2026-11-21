'use client';

import type { ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import type { ConvertedTotal } from '@/lib/currency-total';

/**
 * The pieces the Folio and Pebble hero sets share, so the net worth and the
 * portfolio set are typeset alike: one ruled cell of the statement's figures,
 * one figure of the block, and the move beside the headline.
 */

/** One ruled cell of the Folio statement's figures: a small-caps label over the amount. */
export function StatementFigure({
  label,
  first,
  testId,
  children,
}: {
  label: string;
  first?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`min-w-0 pt-3 ${
        first ? 'pr-3 sm:pr-4' : 'border-l border-gray-200 px-3 sm:px-4 dark:border-gray-700'
      }`}
    >
      <dt className="text-[11px] uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-[15px] text-gray-900 sm:text-lg dark:text-gray-100">{children}</dd>
    </div>
  );
}

export function StatementAmount({
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

/** One figure of the Pebble block: a label over the amount in the grotesque. */
export function BlockFigure({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="ui-display-figure text-[22px] font-semibold tracking-tight text-gray-900 dark:text-gray-50">
        {children}
      </dd>
    </div>
  );
}

/** A small filled triangle, pointing the way the figure moved. */
function ChangeMark({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="flex-shrink-0">
      <path d={up ? 'M6 1 L11 9 H1 Z' : 'M6 11 L1 3 H11 Z'} fill="currentColor" />
    </svg>
  );
}

/**
 * Folio's move under the headline: green or red text with a triangle. `up`
 * `null` is a figure that could not be worked out, in plain gray.
 */
export function FolioChangeLine({ up, children }: { up: boolean | null; children: ReactNode }) {
  if (up === null) {
    return (
      <div data-testid="dashboard-hero-pill" className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
        {children}
      </div>
    );
  }
  return (
    <div
      data-testid="dashboard-hero-pill"
      className={`mt-1.5 flex items-center gap-2 font-medium ${
        up ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
      }`}
    >
      <ChangeMark up={up} />
      <span>{children}</span>
    </div>
  );
}

/**
 * Pebble's move under the headline, a pill on the block, which is dark in both
 * modes: the light end of red and green. `up` `null` is a figure that could
 * not be worked out.
 */
export function PebbleChangePill({ up, children }: { up: boolean | null; children: ReactNode }) {
  return (
    <div className="mt-3.5 flex">
      {up === null ? (
        <span data-testid="dashboard-hero-pill" className="text-sm text-gray-500 dark:text-gray-400">
          {children}
        </span>
      ) : (
        <span
          data-testid="dashboard-hero-pill"
          className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold ${
            up ? 'bg-green-400/15 text-green-400' : 'bg-red-400/15 text-red-400'
          }`}
        >
          {up ? (
            <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {children}
        </span>
      )}
    </div>
  );
}
