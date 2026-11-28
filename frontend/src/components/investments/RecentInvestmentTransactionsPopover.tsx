'use client';

import { useEffect, useRef, useState, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction } from '@/types/investment';
import { TransactionStatus } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import {
  formatSplitRatio,
  InvestmentTotalValue,
  useInvestmentActionInfo,
} from './InvestmentTransactionListParts';

const logger = createLogger('RecentInvestmentTransactionsPopover');

interface RecentInvestmentTransactionsPopoverProps {
  /** Element the popover positions itself relative to (the trigger button). */
  anchorRef: RefObject<HTMLElement | null>;
  /** The brokerage account the form is on; every account when unset. */
  accountId?: string;
  /** The security the form is on; every security in the account when unset. */
  securityId?: string;
  /** How the chosen security reads in the heading, when one is set. */
  securityLabel?: string;
  /** A row's account name, shown while the list spans every account. */
  accountNameFor: (accountId: string) => string | undefined;
  /** Called with the chosen row. The parent closes the popover. */
  onSelect: (transaction: InvestmentTransaction) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 360;

/**
 * The brokerage counterpart of `RecentTransactionsPopover`: the last few rows
 * of the account the new entry is going into, or of the security in it once
 * one is chosen, to quick-fill the form from.
 *
 * The count is the same "recent transactions" preference the cash form's
 * history reads, and the rows come from the register's own list query
 * (newest first), so what is offered is what the register shows at its top.
 */
export function RecentInvestmentTransactionsPopover({
  anchorRef,
  accountId,
  securityId,
  securityLabel,
  accountNameFor,
  onSelect,
  onClose,
}: RecentInvestmentTransactionsPopoverProps) {
  const t = useTranslations('investments');
  const popoverRef = useRef<HTMLDivElement>(null);
  const { formatDate } = useDateFormat();
  const { defaultCurrency, formatCurrency, formatShareQuantity } = useNumberFormat();
  const actionInfoFor = useInvestmentActionInfo();
  const limit = usePreferencesStore((s) => s.preferences?.recentTransactionsLimit ?? 5);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // Each answer is kept with the request that produced it: the account or the
  // security can change while the list is open, and the previous scope's rows
  // (or its failure) must not stand under the new heading. `rows` null is a
  // failed request, never an empty history.
  const requestKey = `${accountId ?? ''}|${securityId ?? ''}|${limit}`;
  const [answer, setAnswer] = useState<{
    key: string;
    rows: InvestmentTransaction[] | null;
  } | null>(null);
  const current = answer?.key === requestKey ? answer : null;
  const isLoading = current === null;
  const failed = current !== null && current.rows === null;
  const transactions = current?.rows ?? [];

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let left = rect.right - POPOVER_WIDTH;
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - POPOVER_WIDTH - 8;
    }
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + 4, left });
  }, [anchorRef]);

  useEffect(() => {
    let cancelled = false;
    investmentsApi
      .getTransactions({
        accountIds: accountId || undefined,
        securityId: securityId || undefined,
        limit,
      })
      .then((result) => {
        if (cancelled) return;
        setAnswer({ key: requestKey, rows: result.data });
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('Failed to load recent investment transactions', err);
        setAnswer({ key: requestKey, rows: null });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, securityId, limit, requestKey]);

  useClickOutside([popoverRef, anchorRef], onClose, { onEscape: onClose });

  if (!position) return null;

  const scopedToSecurity = !!securityId;
  // A security whose label has not resolved yet keeps the plain heading
  // rather than reading "Recent for" and nothing.
  const heading = scopedToSecurity && securityLabel
    ? t('recentPopover.recentForSecurity', { name: securityLabel })
    : t('recentPopover.recentTransactions');

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={heading}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className="fixed z-[100] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
    >
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {heading}
      </div>
      <div className="max-h-80 overflow-y-auto">
        {isLoading && (
          <div className="px-3 py-4 text-sm">
            <LoadingSpinner size="sm" fullContainer={false} text={t('recentPopover.loading')} />
          </div>
        )}
        {!isLoading && failed && (
          <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
            {t('recentPopover.loadFailed')}
          </div>
        )}
        {!isLoading && !failed && transactions.length === 0 && (
          <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
            {scopedToSecurity ? t('recentPopover.noRecentForSecurity') : t('recentPopover.noRecent')}
          </div>
        )}
        {!isLoading && !failed && transactions.length > 0 && (
          <ul>
            {transactions.map((tx) => {
              const actionInfo = actionInfoFor(tx.action);
              // A row that moved no shares (a dividend, interest) says nothing
              // about shares: its stored quantity is absent or zero.
              const hasShares =
                tx.quantity !== null && tx.quantity !== undefined && Number(tx.quantity) !== 0;
              const accountName = accountId ? undefined : accountNameFor(tx.accountId);
              // Struck through and dimmed, as the register draws a VOID row:
              // it records something that did not happen.
              const isVoid = tx.status === TransactionStatus.VOID;
              return (
                <li key={tx.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(tx)}
                    className={`w-full text-left px-3 py-2 ${HOVER_ROW_ON_CARD} focus:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-gray-700/50 border-b last:border-b-0 border-gray-100 dark:border-gray-700 ${isVoid ? 'opacity-50 line-through' : ''}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        <span className={actionInfo.color}>{actionInfo.label}</span>
                        {tx.security?.symbol && (
                          <span className="ml-1.5">{tx.security.symbol}</span>
                        )}
                      </span>
                      <span className="text-sm font-mono text-gray-700 dark:text-gray-200 whitespace-nowrap">
                        <InvestmentTotalValue
                          tx={tx}
                          formatCurrency={formatCurrency}
                          defaultCurrency={defaultCurrency}
                        />
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span className="truncate">
                        {hasShares &&
                          (tx.action === 'SPLIT'
                            ? formatSplitRatio(tx.quantity)
                            : t('recentPopover.shares', {
                                shares: formatShareQuantity(Number(tx.quantity)),
                              }))}
                        {/* With no account chosen the list spans every
                            account, so each row says whose it is. */}
                        {accountName && (
                          <span className={hasShares ? 'ml-2' : undefined}>{accountName}</span>
                        )}
                      </span>
                      <span className="whitespace-nowrap">{formatDate(tx.transactionDate)}</span>
                    </div>
                    {tx.description && (
                      <div
                        className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2 break-words"
                        title={tx.description}
                      >
                        {tx.description}
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
