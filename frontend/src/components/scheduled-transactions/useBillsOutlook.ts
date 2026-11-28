import { useMemo } from 'react';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import {
  nextOccurrenceDueDate,
  nextOccurrenceSpending,
  occurrenceSettlementAccountId,
} from '@/lib/scheduled-effective-amount';
import { occurrenceKind } from '@/lib/scheduled-kind';
import { buildUpcomingStrip, upcomingOccurrences } from '@/components/dashboard/upcoming-occurrences';
import type { BillsOutlookProps } from './variants/bills-outlook-view';

/**
 * The outlook band's data, from the schedules the Bills page already holds.
 * It reuses the dashboard's ordering and its two-week strip, so the band and
 * the Upcoming Bills widget cannot disagree about which occurrence is next.
 *
 * The account it names is the one the cash settles in
 * (`occurrenceSettlementAccountId`), which for a scheduled investment is the
 * funding or linked cash account, not the brokerage (INV-OCCURRENCE-003).
 */
export function useBillsOutlook(
  scheduledTransactions: readonly ScheduledTransaction[],
  accounts: readonly Account[],
  /** `YYYY-MM-DD`, the user's financial today. */
  todayDate: string,
): Pick<BillsOutlookProps, 'strip' | 'next'> {
  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  return useMemo(() => {
    const today = parseLocalDate(todayDate);
    const occurrences = upcomingOccurrences(scheduledTransactions, today, true);
    const strip = buildUpcomingStrip(occurrences, today);
    const first = occurrences[0];
    if (!first) return { strip, next: null };
    const effective = nextOccurrenceSpending(first);
    const settlementId = occurrenceSettlementAccountId(first, accountsById);
    const account = settlementId
      ? (accountsById.get(settlementId)?.name ??
        (settlementId === first.accountId ? first.account?.name : undefined) ??
        null)
      : null;
    return {
      strip,
      next: {
        transaction: first,
        name: first.name,
        payee: first.payeeName || first.payee?.name || null,
        account,
        dueDate: nextOccurrenceDueDate(first),
        amount: effective.amount,
        currencyCode: effective.currencyCode,
        kind: occurrenceKind(effective, first),
      },
    };
  }, [scheduledTransactions, accountsById, todayDate]);
}
