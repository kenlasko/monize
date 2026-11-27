import { getMonthEndYMD } from "../../common/date-utils";
import { roundMoney, sumMoney } from "../../common/round.util";
import { daysBetween } from "../../common/time-series/price-boundary.util";
import type { TopMover } from "../../securities/portfolio.service";
import type { ResolvedScheduledOccurrence } from "../../scheduled-transactions/scheduled-occurrence.service";
import type { TriviaFact } from "./trivia.types";
import {
  count,
  date,
  day,
  days,
  fact,
  money,
  percent,
  text,
} from "./trivia-figures";
import { asOfDay } from "./trivia-windows";

/** One expense line of the budget, as the budget page resolves it. */
export interface TriviaBudgetLine {
  /** `null` when a row of the line had no rate: unknown, never partial. */
  spent: number | null;
  budgeted: number;
}

/**
 * What moves every day. Each source is `null` when it could not be read, which
 * drops its facts and only those. Every span ends at `asOf`, the last
 * complete day before `today`.
 */
export interface TriviaDailyInput {
  currency: string;
  /** The reader's day. */
  today: string;
  monthToDate: {
    through: string;
    spent: number | null;
    previousSpent: number | null;
  } | null;
  lastDay: { date: string; spent: number | null } | null;
  lastSevenDays: { from: string; spent: number | null } | null;
  biggestPurchase: {
    amount: number;
    currency: string;
    payee: string | null;
    date: string;
    /** Every purchase of the window is in `currency`, so they can be ranked. */
    singleCurrency: boolean;
  } | null;
  lastSpendDate: string | null;
  /**
   * The spending report's total over the days after `lastSpendDate`, to the
   * last complete day: the purchase rule behind `lastSpendDate` and the report
   * behind `lastDay` disagree on refunds and transfers, so a streak needs the
   * report to confirm it. `null` when unread.
   */
  streakSpent: number | null;
  sincePayee: { name: string | null; lastDate: string } | null;
  /** `null` when the read was skipped (a page load) or failed. */
  bills: {
    occurrences: ResolvedScheduledOccurrence[];
    total: number | null;
  } | null;
  budget: {
    name: string;
    currency: string;
    incomeLinked: boolean;
    lines: TriviaBudgetLine[];
  } | null;
  topMover: TopMover | null;
}

/** A streak shorter than this is not one; a longer one is a ledger not kept. */
const MIN_NO_SPEND_DAYS = 2;
const MAX_NO_SPEND_DAYS = 30;
/** "Since you last spent with" needs at least this many days. */
const MIN_SINCE_PAYEE_DAYS = 2;
/** A "day" figure carries no year, so a date older than this is a full date. */
const RECENT_DAY_LIMIT = 60;

/** Whether `lastSpendDate` to `asOf` is a streak worth stating. */
export function isStreakLength(lastSpendDate: string, asOf: string): boolean {
  const noSpend = daysBetween(lastSpendDate, asOf);
  return noSpend >= MIN_NO_SPEND_DAYS && noSpend <= MAX_NO_SPEND_DAYS;
}

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value > 0;
}

function monthToDateFacts(input: TriviaDailyInput): TriviaFact[] {
  const { monthToDate: mtd, currency, today } = input;
  if (!mtd || Number(today.slice(8, 10)) < 2) return [];
  if (!positive(mtd.spent) || !positive(mtd.previousSpent)) return [];
  const difference = roundMoney(mtd.spent - mtd.previousSpent);
  if (difference === 0) return [];
  return [
    fact(
      difference < 0 ? "spendingMonthToDateLess" : "spendingMonthToDateMore",
      "spending",
      {
        mtdThrough: day(mtd.through),
        mtdSpent: money(mtd.spent, currency),
        mtdPreviousSpent: money(mtd.previousSpent, currency),
        mtdDifference: money(Math.abs(difference), currency),
      },
    ),
  ];
}

function recentSpendingFacts(input: TriviaDailyInput): TriviaFact[] {
  const { currency } = input;
  const facts: TriviaFact[] = [];
  const { lastDay, lastSevenDays } = input;
  if (lastDay && positive(lastDay.spent)) {
    facts.push(
      fact("spendingLastDay", "spending", {
        lastDayDate: day(lastDay.date),
        lastDaySpent: money(lastDay.spent, currency),
      }),
    );
  }
  if (lastSevenDays && positive(lastSevenDays.spent)) {
    facts.push(
      fact("spendingLastSevenDays", "spending", {
        weekFrom: day(lastSevenDays.from),
        weekSpent: money(lastSevenDays.spent, currency),
      }),
    );
  }
  const purchase = input.biggestPurchase;
  if (
    purchase &&
    purchase.singleCurrency &&
    purchase.currency === currency &&
    purchase.payee
  ) {
    facts.push(
      fact("spendingBiggestRecentPurchase", "spending", {
        recentPurchaseAmount: money(purchase.amount, purchase.currency),
        recentPurchasePayee: text(purchase.payee),
        recentPurchaseDay: day(purchase.date),
      }),
    );
  }
  return facts;
}

function streakFacts(input: TriviaDailyInput): TriviaFact[] {
  const facts: TriviaFact[] = [];
  const asOf = asOfDay(input.today);
  // The report must agree that nothing was spent on the streak's days.
  if (
    input.lastSpendDate &&
    input.streakSpent !== null &&
    input.streakSpent <= 0 &&
    isStreakLength(input.lastSpendDate, asOf)
  ) {
    facts.push(
      fact("spendingNoSpendStreak", "spending", {
        noSpendDays: days(daysBetween(input.lastSpendDate, asOf)),
        lastSpendDay: day(input.lastSpendDate),
      }),
    );
  }
  const since = input.sincePayee;
  if (since?.name) {
    const sinceDays = daysBetween(since.lastDate, input.today);
    if (sinceDays >= MIN_SINCE_PAYEE_DAYS) {
      facts.push(
        fact("spendingDaysSincePayee", "spending", {
          sincePayeeName: text(since.name),
          sincePayeeDays: days(sinceDays),
          // `day` shows a weekday with no year: past two months it is a date.
          sincePayeeDay:
            sinceDays > RECENT_DAY_LIMIT
              ? date(since.lastDate)
              : day(since.lastDate),
        }),
      );
    }
  }
  return facts;
}

function billFacts(input: TriviaDailyInput): TriviaFact[] {
  const { bills, currency } = input;
  if (!bills || bills.occurrences.length === 0) return [];
  const facts: TriviaFact[] = [];
  // An estimate is a forecast, not an amount: a total that holds one, or a next
  // bill that is one, would be stated as exact. Both facts need exact figures.
  if (bills.total !== null && !bills.occurrences.some((o) => o.estimated)) {
    facts.push(
      fact("activityBillsDueThisWeek", "activity", {
        billsDueCount: count(bills.occurrences.length),
        billsDueTotal: money(bills.total, currency),
      }),
    );
  }
  // The next bill is the first one: an unpriced first is no fact, never the
  // second one in its place.
  const next = [...bills.occurrences].sort((a, b) =>
    a.dueDate.localeCompare(b.dueDate),
  )[0];
  if (next.amount !== null && !next.estimated) {
    facts.push(
      fact("activityNextBill", "activity", {
        nextBillName: text(next.schedule.name),
        nextBillAmount: money(Math.abs(next.amount), next.currencyCode),
        nextBillDate: day(next.dueDate),
      }),
    );
  }
  return facts;
}

function budgetFacts(input: TriviaDailyInput): TriviaFact[] {
  const { budget, today } = input;
  // An income-linked budget's total depends on income that may still arrive.
  if (!budget || budget.incomeLinked || budget.lines.length === 0) return [];
  const spents = budget.lines.map((line) => line.spent);
  if (spents.some((spent) => spent === null)) return [];
  const spent = sumMoney(spents as number[]);
  const total = sumMoney(budget.lines.map((line) => line.budgeted));
  if (total <= 0) return [];
  const [year, month] = today.split("-").map(Number);
  const monthDays = Number(getMonthEndYMD(year, month).slice(8, 10));
  return [
    fact("spendingBudgetPace", "spending", {
      budgetName: text(budget.name),
      budgetSpent: money(spent, budget.currency),
      budgetTotal: money(total, budget.currency),
      budgetUsedPercent: percent((spent / total) * 100),
      budgetMonthPercent: percent(
        (Number(today.slice(8, 10)) / monthDays) * 100,
      ),
    }),
  ];
}

function moverFacts(input: TriviaDailyInput): TriviaFact[] {
  const mover = input.topMover;
  if (!mover || mover.dailyChangePercent === 0) return [];
  if (mover.dailyValueChange === null) return [];
  return [
    fact(
      mover.dailyChangePercent > 0
        ? "investmentsTopMoverUp"
        : "investmentsTopMoverDown",
      "investments",
      {
        moverSymbol: text(mover.symbol),
        moverPercent: percent(Math.abs(mover.dailyChangePercent)),
        moverSession: day(mover.priceDate),
        moverValueChange: money(
          Math.abs(mover.dailyValueChange),
          mover.currencyCode,
        ),
      },
    ),
  ];
}

/** The facts that change with the calendar day, one per family at most. */
export function buildDailyTriviaFacts(input: TriviaDailyInput): TriviaFact[] {
  return [
    ...monthToDateFacts(input),
    ...recentSpendingFacts(input),
    ...streakFacts(input),
    ...billFacts(input),
    ...budgetFacts(input),
    ...moverFacts(input),
  ];
}
