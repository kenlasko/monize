/**
 * What a scheduled transaction *is*, as far as any surface listing upcoming
 * occurrences is concerned.
 *
 * The sign of the amount answers only two of the four cases. A transfer moves
 * money between the user's own accounts and is neither a bill nor a deposit,
 * and an amount of exactly zero is a deliberate placeholder -- a reminder for
 * something whose amount is not known until it arrives (a credit card bill, a
 * variable utility). Both are real schedules with real due dates, so both
 * belong on a calendar; classifying with a bare `amount < 0` / `amount > 0`
 * pair silently drops them.
 */
export type ScheduledKind =
  | 'bill'
  | 'deposit'
  | 'transfer'
  | 'reminder'
  | 'unknown';

export function scheduledKind(st: {
  amount: number | string;
  isTransfer?: boolean;
}): ScheduledKind {
  if (st.isTransfer) return 'transfer';
  const amount = Number(st.amount);
  if (!Number.isFinite(amount)) return 'reminder';
  if (amount < 0) return 'bill';
  if (amount > 0) return 'deposit';
  return 'reminder';
}

/**
 * The kind of ONE occurrence.
 *
 * Direction comes from the server's `directionAmount`: the occurrence's own
 * amount when known, the schedule's snapshot only where that sign is *provable*
 * without the missing rate, and `null` when it is not. `null` is `unknown` here,
 * not a guess and not a grey reminder-by-accident -- an unpriceable mixed-sign
 * split posts on either side of zero, so a red bill and a green deposit are
 * equally unfounded (issue #1247 re-audit).
 *
 * An **absent** `directionAmount` is an older backend mid rolling deploy, which
 * is no information: it falls back to the occurrence's amount, then to the
 * schedule's sign, which is what this function did for every case before the
 * server could tell the two apart. The magnitude never comes from the schedule --
 * use the occurrence's `amount`, and `UnknownAmount` when it is null.
 */
type KindLines = { transferAccountId?: string | null }[] | null;
type KindOverride = { isSplit?: boolean | null; splits?: KindLines } | null;

export function occurrenceKind(
  occurrence: {
    amount: number | null;
    directionAmount?: number | null;
    /** The override governing THIS occurrence; when the key is absent, the schedule's `nextOverride`. */
    override?: KindOverride;
  },
  schedule: {
    amount: number | string;
    isTransfer?: boolean;
    isSplit?: boolean;
    splits?: KindLines;
    nextOverride?: KindOverride;
  },
): ScheduledKind {
  if (schedule.isTransfer) return 'transfer';
  // A split made only of transfer lines moves money between the user's own
  // accounts: a transfer, never a reminder of 0. The lines are the occurrence's
  // EFFECTIVE ones, as the server's `classifyScheduledKind` reads them: an
  // override's own splits, none when it says `isSplit === false`, else the
  // template's.
  const override = 'override' in occurrence ? occurrence.override : schedule.nextOverride;
  const lines =
    override?.isSplit === true && override.splits?.length
      ? override.splits
      : override?.isSplit === false || !schedule.isSplit
        ? null
        : schedule.splits;
  if (lines?.length && lines.every((line) => !!line.transferAccountId)) {
    return 'transfer';
  }
  if (occurrence.directionAmount !== undefined) {
    if (occurrence.directionAmount === null) return 'unknown';
    return scheduledKind({ amount: occurrence.directionAmount });
  }
  return scheduledKind({
    amount: occurrence.amount ?? Number(schedule.amount),
  });
}

/**
 * The kind of a budget's upcoming-bill row, which the server has already
 * filtered to what the budget tracks: a reminder at 0, `unknown` while the
 * amount due cannot be worked out, otherwise a bill.
 */
export function upcomingBillKind(bill: {
  amountDue: number | null;
  isReminder: boolean;
}): ScheduledKind {
  if (bill.isReminder) return 'reminder';
  return bill.amountDue === null ? 'unknown' : 'bill';
}

/**
 * Chip styling for a calendar occurrence, so the Bills & Deposits calendar and
 * the Upcoming Bills report read the same way. Red is spending, green is money
 * arriving, blue is a transfer between the user's own accounts, and grey is a
 * zero-amount reminder -- which must not be painted as a deposit merely because
 * it is not negative.
 */
export const SCHEDULED_KIND_CHIP_CLASSES: Record<ScheduledKind, string> = {
  bill: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  deposit: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  transfer: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  reminder: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  // Neutral on purpose: red would say "you owe this" and green "this is coming
  // in", and an occurrence whose direction is not derivable supports neither.
  unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

/** Text colour for the amount printed beside an occurrence, by the same rule. */
export const SCHEDULED_KIND_AMOUNT_CLASSES: Record<ScheduledKind, string> = {
  bill: 'text-red-600 dark:text-red-400',
  deposit: 'text-green-600 dark:text-green-400',
  transfer: 'text-blue-600 dark:text-blue-400',
  reminder: 'text-gray-500 dark:text-gray-400',
  unknown: 'text-gray-500 dark:text-gray-400',
};
