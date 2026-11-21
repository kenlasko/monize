import { useMemo } from 'react';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { nextOccurrenceDueDate, nextOccurrenceEffectiveAmount } from '@/lib/scheduled-effective-amount';
import { occurrenceKind } from '@/lib/scheduled-kind';
import { buildUpcomingStrip, upcomingOccurrences } from '@/components/dashboard/upcoming-occurrences';
import type { BillsOutlookProps } from './variants/bills-outlook-view';

/**
 * The outlook band's data, from the schedules the Bills page already holds.
 * It reuses the dashboard's ordering and its two-week strip, so the band and
 * the Upcoming Bills widget cannot disagree about which occurrence is next.
 */
export function useBillsOutlook(
  scheduledTransactions: readonly ScheduledTransaction[],
  /** `YYYY-MM-DD`, the user's financial today. */
  todayDate: string,
): Pick<BillsOutlookProps, 'strip' | 'next'> {
  return useMemo(() => {
    const today = parseLocalDate(todayDate);
    const occurrences = upcomingOccurrences(scheduledTransactions, today, true);
    const strip = buildUpcomingStrip(occurrences, today);
    const first = occurrences[0];
    if (!first) return { strip, next: null };
    const effective = nextOccurrenceEffectiveAmount(first);
    return {
      strip,
      next: {
        transaction: first,
        name: first.name,
        payee: first.payeeName || first.payee?.name || null,
        account: first.account?.name ?? null,
        dueDate: nextOccurrenceDueDate(first),
        amount: effective.amount,
        currencyCode: effective.currencyCode,
        kind: occurrenceKind(effective, first),
      },
    };
  }, [scheduledTransactions, todayDate]);
}
