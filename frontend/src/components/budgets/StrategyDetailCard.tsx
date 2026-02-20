'use client';

import type { BudgetStrategy } from '@/types/budget';

interface StrategyDetail {
  title: string;
  description: string;
  pros: string[];
  cons: string[];
  bestFor: string;
}

const STRATEGY_DETAILS: Record<BudgetStrategy, StrategyDetail> = {
  FIXED: {
    title: 'Fixed Budget',
    description:
      'Set a fixed spending limit for each category every period. Any unspent money resets at the end of the period rather than carrying forward.',
    pros: [
      'Simple to set up and understand',
      'Clear spending limits per category',
      'Predictable month-to-month budgeting',
      'Good starting point for budgeting beginners',
    ],
    cons: [
      'Unspent money does not carry over',
      'No flexibility between categories',
      'Does not adapt to irregular expenses',
      'Can feel rigid if spending patterns vary',
    ],
    bestFor:
      'People who want straightforward budgeting with clear limits and predictable spending patterns.',
  },
  ROLLOVER: {
    title: 'Rollover Budget',
    description:
      'Unspent budget carries forward to the next period based on per-category rollover rules. Build up reserves for categories with irregular or seasonal spending.',
    pros: [
      'Builds savings for irregular expenses',
      'Rewards under-spending in categories',
      'Flexible rollover rules per category',
      'Handles seasonal variation naturally',
    ],
    cons: [
      'More complex to configure initially',
      'Accumulated balances need monitoring',
      'Can mask overspending if caps are too high',
      'Requires periodic review of rollover rules',
    ],
    bestFor:
      'People with irregular expenses like car maintenance, annual subscriptions, or seasonal costs who want to save up gradually.',
  },
  ZERO_BASED: {
    title: 'Zero-Based Budget',
    description:
      'Every dollar of income is assigned a specific purpose. Your income minus all budgeted amounts should equal zero, ensuring no money is left unallocated.',
    pros: [
      'Maximum control over every dollar',
      'Forces intentional spending decisions',
      'Quickly reveals wasteful spending',
      'Highly effective for debt payoff goals',
    ],
    cons: [
      'Requires knowing exact income in advance',
      'Time-intensive to maintain each period',
      'Less flexible for variable income',
      'Can feel restrictive for some users',
    ],
    bestFor:
      'People who want total control over their finances and are willing to plan where every dollar goes each period.',
  },
  FIFTY_THIRTY_TWENTY: {
    title: '50/30/20 Budget',
    description:
      'A balanced approach that divides income into three groups: 50% for needs (housing, groceries, utilities), 30% for wants (dining, entertainment), and 20% for savings and debt repayment.',
    pros: [
      'Easy to remember and follow',
      'Built-in savings allocation',
      'Balanced approach to spending',
      'Flexible within each group',
    ],
    cons: [
      'May not suit high cost-of-living areas',
      'Fixed ratios may not fit all situations',
      'Less granular category-level control',
      'Requires categorizing every expense by group',
    ],
    bestFor:
      'People who want a balanced, rule-of-thumb approach without tracking every category individually.',
  },
};

interface StrategyDetailCardProps {
  strategy: BudgetStrategy;
}

export function StrategyDetailCard({ strategy }: StrategyDetailCardProps) {
  const detail = STRATEGY_DETAILS[strategy];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <h4 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {detail.title}
      </h4>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {detail.description}
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h5 className="text-sm font-medium text-green-700 dark:text-green-400">
            Pros
          </h5>
          <ul className="mt-2 space-y-1.5">
            {detail.pros.map((pro) => (
              <li
                key={pro}
                className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
              >
                <span className="mt-0.5 text-green-500 dark:text-green-400">
                  +
                </span>
                {pro}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h5 className="text-sm font-medium text-amber-700 dark:text-amber-400">
            Cons
          </h5>
          <ul className="mt-2 space-y-1.5">
            {detail.cons.map((con) => (
              <li
                key={con}
                className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
              >
                <span className="mt-0.5 text-amber-500 dark:text-amber-400">
                  -
                </span>
                {con}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-5 rounded-md bg-blue-50 p-3 dark:bg-blue-900/20">
        <p className="text-sm text-blue-800 dark:text-blue-300">
          <span className="font-medium">Best for: </span>
          {detail.bestFor}
        </p>
      </div>
    </div>
  );
}
