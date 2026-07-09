'use client';

import { useMemo } from 'react';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { GroupedTotal } from '@/types/transaction';

interface TopGroupsPanelProps {
  title: string;
  emptyLabel: string;
  fallbackLabel: string;
  totals: GroupedTotal[];
  currencyCode: string;
  isLoading: boolean;
  limit?: number;
  /** When set, each identified row becomes a link to its filtered transactions. */
  onSelect?: (id: string) => void;
}

/**
 * A ranked list of grouped totals (top categories or payees) by magnitude, with
 * a proportional bar and sign-coloured amounts. Shared between the category and
 * payee breakdowns on the banking detail view.
 */
export function TopGroupsPanel({
  title,
  emptyLabel,
  fallbackLabel,
  totals,
  currencyCode,
  isLoading,
  limit = 6,
  onSelect,
}: TopGroupsPanelProps) {
  const { formatCurrency } = useNumberFormat();

  const rows = useMemo(() => {
    const ranked = [...totals]
      .filter((g) => Math.abs(Number(g.total) || 0) > 0)
      .sort((a, b) => Math.abs(Number(b.total)) - Math.abs(Number(a.total)))
      .slice(0, limit);
    const max = ranked.reduce((m, g) => Math.max(m, Math.abs(Number(g.total))), 0);
    return { ranked, max };
  }, [totals, limit]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{title}</h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : rows.ranked.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{emptyLabel}</p>
        ) : (
          <ul className="space-y-3">
            {rows.ranked.map((g, i) => {
              const amount = Number(g.total) || 0;
              const clickable = !!onSelect && !!g.id;
              const body = (
                <>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-200 truncate">
                      {g.name ?? fallbackLabel}
                    </span>
                    <span
                      className={`font-medium tabular-nums ${
                        amount < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-green-600 dark:text-green-400'
                      }`}
                    >
                      {formatCurrency(Math.abs(amount), currencyCode)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        amount < 0 ? 'bg-red-400 dark:bg-red-500' : 'bg-green-400 dark:bg-green-500'
                      }`}
                      style={{ width: `${rows.max > 0 ? (Math.abs(amount) / rows.max) * 100 : 0}%` }}
                    />
                  </div>
                </>
              );
              return (
                <li key={`${g.id ?? 'none'}-${i}`}>
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => onSelect!(g.id!)}
                      className="block w-full text-left -mx-1 px-1 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
