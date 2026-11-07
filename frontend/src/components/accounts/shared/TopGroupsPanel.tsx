'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { GroupedTotal } from '@/types/transaction';

interface TopGroupsPanelProps {
  title: string;
  /** Optional timeframe caption shown under the title (e.g. "This month"). */
  subtitle?: string;
  emptyLabel: string;
  fallbackLabel: string;
  totals: GroupedTotal[];
  currencyCode: string;
  isLoading: boolean;
  limit?: number;
  /**
   * How many rows were dropped upstream for want of a rate. When set, a note
   * marks the breakdown as a subtotal rather than letting the ranked bars read
   * as 100% of the whole.
   */
  excludedCount?: number;
  /** When set, each row becomes a link to its filtered transactions (id may be null). */
  onSelect?: (id: string | null) => void;
  /** Allow the unidentified (e.g. uncategorised) row to be selectable too. */
  selectableWhenUnidentified?: boolean;
  /**
   * Control rendered at the right of the heading row (e.g. a range toggle).
   * Omitted, the heading keeps the full width exactly as before.
   */
  headerAction?: ReactNode;
}

/**
 * A ranked list of grouped totals (top categories or payees) by magnitude, with
 * a proportional bar and sign-coloured amounts. Shared between the category and
 * payee breakdowns on the banking detail view.
 */
export function TopGroupsPanel({
  title,
  subtitle,
  emptyLabel,
  fallbackLabel,
  totals,
  currencyCode,
  isLoading,
  limit = 6,
  onSelect,
  selectableWhenUnidentified = false,
  headerAction,
  excludedCount = 0,
}: TopGroupsPanelProps) {
  const { formatCurrency } = useNumberFormat();
  const tCommon = useTranslations('common');

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
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse skeleton-shimmer" />
        ) : rows.ranked.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{emptyLabel}</p>
        ) : (
          <ul className="space-y-3">
            {rows.ranked.map((g, i) => {
              const amount = Number(g.total) || 0;
              const clickable = !!onSelect && (g.id != null || selectableWhenUnidentified);
              // Outflows -- nearly every row on these panels -- take the theme
              // accent, not red. Red is reserved for the Monthly Totals chart,
              // where a loss month is the point; spending it again on a routine
              // breakdown makes ordinary spending read as an alarm and leaves
              // the panel the one thing on screen ignoring the palette. Inflows
              // stay green so a refund is still distinguishable at a glance.
              // Amount and bar share the one token so the row reads as a single
              // mark.
              const signColor = amount > 0 ? chartColors.income : chartColors.primary;
              const body = (
                <>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-200 truncate">
                      {g.name ?? fallbackLabel}
                    </span>
                    <span
                      className="font-medium tabular-nums"
                      style={{ color: signColor }}
                    >
                      {formatCurrency(Math.abs(amount), currencyCode)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${rows.max > 0 ? (Math.abs(amount) / rows.max) * 100 : 0}%`,
                        backgroundColor: signColor,
                      }}
                    />
                  </div>
                </>
              );
              return (
                <li key={`${g.id ?? 'none'}-${i}`}>
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => onSelect!(g.id)}
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
        {excludedCount > 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="partial-note">
            {tCommon('partialTotal.explanationExcluded', { count: excludedCount })}
          </p>
        )}
      </div>
    </section>
  );
}
