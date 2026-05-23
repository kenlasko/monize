'use client';

import { useEffect, useRef, useState, RefObject } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { formatCurrency } from '@/lib/format';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('RecentTransactionsPopover');

interface RecentTransactionsPopoverProps {
  /** Element the popover positions itself relative to (the trigger button). */
  anchorRef: RefObject<HTMLElement | null>;
  /** When set, scopes results to this payee; otherwise returns global deduped recents. */
  payeeId?: string;
  /** Free-text payee name fallback when no payeeId. Ignored if payeeId is set. */
  payeeName?: string;
  /** Called with the chosen transaction when the user picks a row. Closes the popover. */
  onSelect: (transaction: Transaction) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 360;

function formatSplitCategoryLabel(t: Transaction): string {
  const categories = (t.splits ?? [])
    .map((s) => s.category?.name)
    .filter((name): name is string => !!name);
  if (categories.length === 0) {
    return `Split (${(t.splits ?? []).length} items)`;
  }
  const unique = Array.from(new Set(categories));
  if (unique.length <= 2) return `Split: ${unique.join(', ')}`;
  return `Split: ${unique.slice(0, 2).join(', ')} +${unique.length - 2}`;
}

export function RecentTransactionsPopover({
  anchorRef,
  payeeId,
  payeeName,
  onSelect,
  onClose,
}: RecentTransactionsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const { formatDate } = useDateFormat();
  const limit = usePreferencesStore((s) => s.preferences?.recentTransactionsLimit ?? 5);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // The popover is mounted-on-open by the parent, so the fetch always starts
  // fresh - default to loading=true and clear once the request resolves.
  const [isLoading, setIsLoading] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Position next to the anchor button
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - POPOVER_WIDTH - 8;
    }
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + 4, left });
  }, [anchorRef]);

  // Fetch on mount (the popover is unmounted/remounted by the parent on open/close)
  useEffect(() => {
    let cancelled = false;
    transactionsApi
      .getRecent({
        limit,
        payeeId: payeeId || undefined,
        payeeName: payeeId ? undefined : payeeName || undefined,
      })
      .then((rows) => {
        if (cancelled) return;
        setTransactions(rows);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('Failed to load recent transactions', err);
        setError('Could not load recent transactions');
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payeeId, payeeName, limit]);

  // Outside-click and escape
  useClickOutside([popoverRef, anchorRef], onClose, { onEscape: onClose });

  if (!position) return null;

  const heading = payeeId || payeeName ? `Recent for ${payeeName || 'this payee'}` : 'Recent transactions';

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={heading}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className="fixed z-50 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
    >
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {heading}
      </div>
      <div className="max-h-80 overflow-y-auto">
        {isLoading && (
          <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
        )}
        {!isLoading && error && (
          <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">{error}</div>
        )}
        {!isLoading && !error && transactions.length === 0 && (
          <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
            No recent transactions{payeeId || payeeName ? ' for this payee' : ''}.
          </div>
        )}
        {!isLoading && !error && transactions.length > 0 && (
          <ul>
            {transactions.map((t) => {
              const payeeLabel = t.payeeName || t.payee?.name || '(no payee)';
              const categoryLabel = t.isSplit
                ? formatSplitCategoryLabel(t)
                : t.category?.name || '(uncategorized)';
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:outline-none border-b last:border-b-0 border-gray-100 dark:border-gray-700"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {payeeLabel}
                      </span>
                      <span className="text-sm font-mono text-gray-700 dark:text-gray-200 whitespace-nowrap">
                        {formatCurrency(Number(t.amount), t.currencyCode)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span className="truncate">{categoryLabel}</span>
                      <span className="whitespace-nowrap">{formatDate(t.transactionDate)}</span>
                    </div>
                    {t.description && (
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                        {t.description}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
