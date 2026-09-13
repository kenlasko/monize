import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { AccountType } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type {
  ScheduledOccurrence,
  ScheduledTransaction,
} from '@/types/scheduled-transaction';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { SCHEDULED_KIND_CHIP_CLASSES, occurrenceKind } from '@/lib/scheduled-kind';

/**
 * Putting the calendar's items on their days, and deciding how each chip looks.
 *
 * Grouping only. Nothing here adds, converts or compares money: a chip's
 * amount is the one the server sent for that row or that occurrence, and its
 * colour comes from the mapping that already owns the question
 * (`ACCOUNT_TYPE_META` for an account's type, `SCHEDULED_KIND_CHIP_CLASSES`
 * for an occurrence's kind). A second colour switch here would disagree with
 * the account list and the bills calendar the first time either changed.
 */

/** The calendar-relevant part of an account; the full row is never needed. */
export interface CalendarAccount {
  id: string;
  accountType: AccountType;
  linkedAccountId?: string | null;
}

export interface TransactionChip {
  key: string;
  transaction: Transaction;
  /** From `ACCOUNT_TYPE_META`, so a chip matches its account's pill. */
  className: string;
  /** A void row moved no balance, and is drawn struck through. */
  isVoid: boolean;
  /** Dated after the server's today; dimmed the way the register dims it. */
  isFuture: boolean;
}

export interface OccurrenceChip {
  key: string;
  occurrence: ScheduledOccurrence;
  schedule: ScheduledTransaction;
  /** From `SCHEDULED_KIND_CHIP_CLASSES`, by the occurrence's own direction. */
  className: string;
  /** Due before today and still unposted: the reader is behind on it. */
  isOverdue: boolean;
}

/**
 * One brokerage row on the Investments calendar.
 *
 * A trade is one economic event even though it writes two rows -- the trade and
 * the cash leg that settles it -- and this is the one the reader means, so the
 * cash leg is dropped by `dedupeInvestmentLegs` when this row is in scope (I5).
 */
export interface InvestmentChip {
  key: string;
  transaction: InvestmentTransaction;
  /** Always the investment pill: the row belongs to a brokerage by definition. */
  className: string;
  isVoid: boolean;
  isFuture: boolean;
}

export interface CalendarDayRows {
  transactions: TransactionChip[];
  occurrences: OccurrenceChip[];
  /** Brokerage rows; empty on the Transactions calendar, which has none. */
  investments: InvestmentChip[];
}

/** A row's calendar day, whether the server sent a date or a timestamp. */
export function rowDate(value: string): string {
  return value.split('T')[0];
}

/**
 * Group anything by the day it falls on, preserving the order it arrived in.
 *
 * The server already ordered the rows; re-sorting here would be a second
 * opinion about register order, which `applyRegisterOrder` owns.
 */
export function groupRowsByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => string,
): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const day = dateOf(item);
    const existing = byDay.get(day);
    if (existing) existing.push(item);
    else byDay.set(day, [item]);
  }
  return byDay;
}

/**
 * How one real transaction is drawn.
 *
 * An account the client does not hold still gets a chip: the row is money that
 * moved, and dropping it because the accounts request answered short would
 * take a day's figures with it. It falls back to the neutral `OTHER` pill
 * rather than to a colour that would claim a type.
 */
export function chipForTransaction(
  transaction: Transaction,
  accountsById: ReadonlyMap<string, CalendarAccount>,
  today: string,
): TransactionChip {
  const accountType = accountsById.get(transaction.accountId)?.accountType ?? 'OTHER';
  return {
    key: transaction.id,
    transaction,
    className: ACCOUNT_TYPE_META[accountType].pillClass,
    isVoid: transaction.status === TransactionStatus.VOID,
    isFuture: rowDate(transaction.transactionDate) > today,
  };
}

/**
 * How one scheduled occurrence is drawn.
 *
 * The kind is `occurrenceKind`, which reads the server's resolved direction for
 * that occurrence and answers `unknown` when it cannot be derived. Nothing here
 * looks at the schedule's stored amount: that scalar was priced at whatever
 * rate was current when it was written (INV-OCCURRENCE-003).
 */
export function chipForOccurrence(
  occurrence: ScheduledOccurrence,
  schedule: ScheduledTransaction,
  today: string,
): OccurrenceChip {
  return {
    key: `${occurrence.scheduledTransactionId}:${occurrence.originalDate}`,
    occurrence,
    schedule,
    className: SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(occurrence, schedule)],
    isOverdue: rowDate(occurrence.dueDate) < today,
  };
}

/**
 * A day's rows, earliest first.
 *
 * The register answers newest first, and within a day its order is TOTAL:
 * `applyRegisterOrder` sorts on the date, then `created_at`, then credits before
 * debits, then the id, all in the one direction. Reversing a day's slice is
 * therefore that same ordering read the other way -- the register's own ascending
 * order, not a second opinion about it -- and it is what makes a calendar day
 * read top to bottom as the day happened. The brokerage list is ordered the same
 * way (`transactionDate`, then `createdAt`, descending), so it reverses with it.
 *
 * Occurrences are left alone: they arrive by due date ascending, which is
 * already earliest first, and a scheduled item has no time of day to order by.
 */
function earliestFirst(days: Map<string, CalendarDayRows>): Map<string, CalendarDayRows> {
  return new Map(
    [...days].map(([date, rows]) => [
      date,
      {
        ...rows,
        transactions: [...rows.transactions].reverse(),
        investments: [...rows.investments].reverse(),
      },
    ]),
  );
}

/**
 * Every chip the Transactions calendar draws, keyed by day.
 *
 * An occurrence whose schedule the client does not hold is dropped: its chip
 * would have no name to print and no kind to colour, and inventing either is
 * worse than the schedule list arriving a moment later.
 */
export function groupCalendarRows(input: {
  transactions: readonly Transaction[];
  occurrences: readonly ScheduledOccurrence[];
  schedulesById: ReadonlyMap<string, ScheduledTransaction>;
  accountsById: ReadonlyMap<string, CalendarAccount>;
  today: string;
}): Map<string, CalendarDayRows> {
  const { transactions, occurrences, schedulesById, accountsById, today } = input;
  const days = new Map<string, CalendarDayRows>();

  const dayOf = (date: string): CalendarDayRows => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: CalendarDayRows = { transactions: [], occurrences: [], investments: [] };
    days.set(date, created);
    return created;
  };

  for (const transaction of transactions) {
    dayOf(rowDate(transaction.transactionDate)).transactions.push(
      chipForTransaction(transaction, accountsById, today),
    );
  }

  for (const occurrence of occurrences) {
    const schedule = schedulesById.get(occurrence.scheduledTransactionId);
    if (!schedule) continue;
    dayOf(rowDate(occurrence.dueDate)).occurrences.push(
      chipForOccurrence(occurrence, schedule, today),
    );
  }

  return earliestFirst(days);
}

/**
 * How one brokerage row is drawn.
 *
 * The pill is the investment one whatever account the row sits in: a brokerage
 * row is a trade, and the Investments calendar's other chips are the cash
 * sleeve's, which keep their own account's colour.
 */
export function chipForInvestment(
  transaction: InvestmentTransaction,
  today: string,
): InvestmentChip {
  return {
    key: transaction.id,
    transaction,
    className: ACCOUNT_TYPE_META.INVESTMENT.pillClass,
    isVoid: transaction.status === TransactionStatus.VOID,
    isFuture: rowDate(transaction.transactionDate) > today,
  };
}

/**
 * One economic event, one chip (design decision 5, I5).
 *
 * A trade writes two rows: the brokerage row and the cash-sleeve row that
 * settles it, linked by `linkedInvestmentTransactionId`. Drawing both would
 * show a purchase twice and read as two events on the same day. The brokerage
 * row is the one that names the security, so the cash leg goes -- but only when
 * its trade is actually on screen: a scope holding the cash sleeve without its
 * brokerage keeps the cash row, which is then the only record of the movement
 * the reader can see.
 */
export function dedupeInvestmentLegs(
  cashRows: readonly Transaction[],
  brokerageRowIds: ReadonlySet<string>,
): Transaction[] {
  return cashRows.filter((row) => {
    const linked = row.linkedInvestmentTransactionId;
    return !linked || !brokerageRowIds.has(linked);
  });
}

/**
 * Every chip the Investments calendar draws, keyed by day.
 *
 * The cash rows arrive already deduped against the brokerage rows, so this adds
 * nothing up and decides nothing about what belongs on a day beyond the date
 * each row carries.
 */
export function groupInvestmentCalendarRows(input: {
  brokerage: readonly InvestmentTransaction[];
  cash: readonly Transaction[];
  accountsById: ReadonlyMap<string, CalendarAccount>;
  today: string;
}): Map<string, CalendarDayRows> {
  const { brokerage, cash, accountsById, today } = input;
  const days = new Map<string, CalendarDayRows>();

  const dayOf = (date: string): CalendarDayRows => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: CalendarDayRows = { transactions: [], occurrences: [], investments: [] };
    days.set(date, created);
    return created;
  };

  for (const row of brokerage) {
    dayOf(rowDate(row.transactionDate)).investments.push(chipForInvestment(row, today));
  }

  for (const row of cash) {
    dayOf(rowDate(row.transactionDate)).transactions.push(
      chipForTransaction(row, accountsById, today),
    );
  }

  return earliestFirst(days);
}
