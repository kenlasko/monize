import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { ScheduledKind } from '@/lib/scheduled-kind';
import type { UpcomingStrip } from '@/components/dashboard/variants/upcoming-bills-view';

/** The nearest scheduled occurrence, as the Pebble "next up" block shows it. */
export interface BillsOutlookNext {
  transaction: ScheduledTransaction;
  name: string;
  payee: string | null;
  account: string | null;
  /** The occurrence's own due date, `YYYY-MM-DD`. */
  dueDate: string;
  /** Signed as the schedule stores it; `null` when it cannot be worked out. */
  amount: number | null;
  currencyCode: string;
  kind: ScheduledKind;
}

/**
 * What the Bills page hands the Folio and Pebble outlook band. The page's
 * `useBillsOutlook` derives it from the schedules it already holds; a variant
 * only lays it out.
 */
export interface BillsOutlookProps {
  /** The fourteen days from today with their occurrences. */
  strip: UpcomingStrip;
  /** `null` when no active schedule has an occurrence ahead. */
  next: BillsOutlookNext | null;
  onPost: (transaction: ScheduledTransaction) => void;
}
