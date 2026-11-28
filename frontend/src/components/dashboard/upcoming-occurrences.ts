import { addDays, differenceInDays, format } from 'date-fns';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import {
  nextOccurrenceAutoPosts,
  nextOccurrenceDueDate,
  nextOccurrenceSpending,
} from '@/lib/scheduled-effective-amount';
import { occurrenceKind } from '@/lib/scheduled-kind';
import type { UpcomingStrip, UpcomingStripDay } from './variants/upcoming-bills-view';

/**
 * The scheduled occurrences the dashboard lists, in the order it lists them:
 * active schedules only, by next due date, manual ones first on a shared day so
 * they survive truncation. Under `showAll` every active schedule's next
 * occurrence is in; otherwise only what is overdue or inside its own reminder
 * window. Written once so the Upcoming Bills widget and the hero's "next up"
 * card can never disagree about which occurrence comes next.
 */
export function upcomingOccurrences(
  scheduledTransactions: readonly ScheduledTransaction[],
  today: Date,
  showAll: boolean,
): ScheduledTransaction[] {
  return scheduledTransactions
    .filter((st) => {
      if (!st.isActive) return false;
      if (showAll) return true;
      const dueDate = parseLocalDate(nextOccurrenceDueDate(st));
      const daysUntil = differenceInDays(dueDate, today);
      // Include overdue items (daysUntil < 0) and items within their reminder window
      return daysUntil < 0 || (daysUntil >= 0 && daysUntil <= (st.reminderDaysBefore ?? 3));
    })
    .sort((a, b) => {
      const dateDiff =
        parseLocalDate(nextOccurrenceDueDate(a)).getTime() -
        parseLocalDate(nextOccurrenceDueDate(b)).getTime();
      if (dateDiff !== 0) return dateDiff;
      // On the same day, show manual items first so they're visible before truncation
      const aAuto = nextOccurrenceAutoPosts(a);
      const bAuto = nextOccurrenceAutoPosts(b);
      if (!aAuto && bAuto) return -1;
      if (aAuto && !bAuto) return 1;
      return 0;
    });
}

/** How many days the dashboard's two-week strip covers, today included. */
export const UPCOMING_STRIP_DAYS = 14;

/**
 * The two weeks from `today` with the occurrences that fall on each day, for
 * the strip the Folio and Pebble styles draw above the list. An overdue
 * occurrence is on the list but not on the strip, which starts today. Bars are
 * to scale only while every known amount on the strip is in one currency
 * (`scaleMax`); otherwise they say direction alone, since two currencies are
 * not comparable without a rate and this widget reads none.
 */
export function buildUpcomingStrip(
  occurrences: readonly ScheduledTransaction[],
  today: Date,
): UpcomingStrip {
  const days: UpcomingStripDay[] = Array.from({ length: UPCOMING_STRIP_DAYS }, (_, offset) => ({
    date: format(addDays(today, offset), 'yyyy-MM-dd'),
    isToday: offset === 0,
    items: [],
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const currencies = new Set<string>();
  let scaleMax = 0;
  for (const st of occurrences) {
    const day = byDate.get(nextOccurrenceDueDate(st));
    if (!day) continue;
    const effective = nextOccurrenceSpending(st);
    const magnitude = effective.amount === null ? null : Math.abs(effective.amount);
    if (magnitude !== null) {
      currencies.add(effective.currencyCode);
      scaleMax = Math.max(scaleMax, magnitude);
    }
    day.items.push({
      id: st.id,
      name: st.name,
      kind: occurrenceKind(effective, st),
      payee: st.payeeName || st.payee?.name || null,
      magnitude,
      currencyCode: effective.currencyCode,
    });
  }
  return { days, scaleMax: currencies.size === 1 ? scaleMax : null };
}
