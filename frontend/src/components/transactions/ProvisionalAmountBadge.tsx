'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { isProvisionalAmount } from '@/lib/provisional-amount';
import type { Transaction } from '@/types/transaction';

interface ProvisionalAmountBadgeProps {
  transaction: Pick<Transaction, 'amountIsProvisional'>;
  /**
   * Draw the label in the row's own colour rather than the muted grey: the
   * Pebble register's inspected row is set on ink, where grey reads as
   * disabled.
   */
  onInk?: boolean;
  /** Which edge the label sits on: the amount column's right edge, or a headline figure's left. */
  align?: 'start' | 'end';
}

/**
 * The muted "Estimated amount" label under a provisional leg's amount, with a
 * tooltip saying what the estimate is and how it stops being one (design
 * section 9 of `docs/future-plans/provisional-amounts.md`). It follows the
 * schedule estimate's label in `ScheduledTransactionList`: a word and a help
 * icon, never a colour alone. A confirmed row renders nothing.
 */
export function ProvisionalAmountBadge({
  transaction,
  onInk = false,
  align = 'end',
}: ProvisionalAmountBadgeProps) {
  const t = useTranslations('transactions');
  if (!isProvisionalAmount(transaction)) return null;
  return (
    <span
      data-testid="provisional-amount-badge"
      className={`flex items-center gap-1 text-xs font-normal ${
        align === 'end' ? 'justify-end' : 'justify-start'
      } ${onInk ? 'opacity-70' : 'text-gray-500 dark:text-gray-400'}`}
    >
      <span>{t('provisional.label')}</span>
      <InfoTooltip
        text={t('provisional.tooltip')}
        iconClassName="h-3.5 w-3.5"
        align={align === 'end' ? 'right' : 'left'}
        usePortal
      />
    </span>
  );
}
