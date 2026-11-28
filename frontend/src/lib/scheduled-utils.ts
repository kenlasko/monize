import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { nextOccurrenceEffectiveAmount } from '@/lib/scheduled-effective-amount';

export interface NextScheduledItem {
  date: string;
  /**
   * What this occurrence would post today, from the server's effective-amount
   * contract -- `null` when the current amount cannot be determined (issue
   * #1247). Never the persisted snapshot: render unknown as unknown.
   */
  amount: number | null;
  /** The currency `amount` is in (the settlement currency for an investment). */
  currencyCode: string;
  payeeName: string | null;
}

/**
 * The soonest active scheduled bills/deposits matching `predicate`, ordered by
 * due date and honouring a per-occurrence override for both the date and the
 * amount. One next occurrence per schedule -- this lists which schedules are
 * coming up, not a projected calendar.
 */
export function getUpcomingScheduled(
  scheduled: ScheduledTransaction[],
  predicate: (st: ScheduledTransaction) => boolean,
  limit: number,
): NextScheduledItem[] {
  return scheduled
    .filter((st) => st.isActive && predicate(st))
    .map((st) => {
      const effective = nextOccurrenceEffectiveAmount(st);
      return {
        date: (st.nextOverride?.overrideDate ?? st.nextDueDate).split('T')[0],
        amount: effective.amount,
        currencyCode: effective.currencyCode,
        payeeName: st.payee?.name ?? st.payeeName ?? null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}

/**
 * The soonest active scheduled bill/deposit matching `predicate`, honouring
 * a per-occurrence override for both the date and the amount. Shared by the
 * account/payee/category info widgets on the Transactions page.
 */
export function getNextScheduled(
  scheduled: ScheduledTransaction[],
  predicate: (st: ScheduledTransaction) => boolean,
): NextScheduledItem | null {
  return getUpcomingScheduled(scheduled, predicate, 1)[0] ?? null;
}
