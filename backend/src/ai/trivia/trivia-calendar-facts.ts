import { getMonthEndYMD } from "../../common/date-utils";
import { roundMoney } from "../../common/round.util";
import { daysBetween } from "../../common/time-series/price-boundary.util";
import type { SpendingByCategoryResponse } from "../../built-in-reports/dto/spending-by-category.dto";
import type { TriviaFact } from "./trivia.types";
import { monthsBetween, type TriviaNetWorthMonth } from "./trivia-facts";
import type {
  TriviaRecordCounts,
  TriviaWarranties,
} from "./trivia-ledger-facts";
import {
  count,
  date,
  days,
  fact,
  money,
  month,
  text,
  years,
} from "./trivia-figures";

/** What `TriviaCalendarLoader` reads. Each source is `null` when it failed. */
export interface TriviaCalendarData {
  /** Open accounts and the date of the first row in each, names stripped. */
  accountFirstDates: { name: string; firstDate: string }[] | null;
  /** Rows recorded (created) more than 30 days ago. */
  transactionsRecordedBefore: number | null;
  /** Spending over the whole month a year before `today`'s. */
  yearAgoMonth: SpendingByCategoryResponse | null;
}

export interface TriviaCalendarInput {
  /** The reader's day. */
  today: string;
  currency: string;
  months: TriviaNetWorthMonth[];
  records: TriviaRecordCounts | null;
  warranties: TriviaWarranties | null;
  calendar: TriviaCalendarData;
}

/** An anniversary is "this week" for this many days from its date. */
const WEEK_DAYS = 7;
const MIN_WARRANTY_DAYS = 1;
const MAX_WARRANTY_DAYS = 30;
/** Net worth milestones start here: {1, 2, 5} x 10^k from 1,000 up. */
const MIN_NET_WORTH_MILESTONE = 1000;
const NET_WORTH_STEPS = [1, 2, 5];
const TRANSACTION_MILESTONES = [100, 250, 500];
const TRANSACTION_MILESTONE_STEP = 1000;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The date's month and day in `year`; 02-29 reads as 02-28 outside a leap year. */
function anniversaryIn(first: string, year: number): string {
  const monthDay = first.slice(5);
  const clamped =
    monthDay === "02-29" && !isLeapYear(year) ? "02-28" : monthDay;
  return `${year}-${clamped}`;
}

/**
 * The whole years since `first` when `today` is in the anniversary's week, else
 * `null`. Last year's anniversary is tried too, so one on December 30 is still
 * caught on January 2.
 */
export function anniversaryYears(first: string, today: string): number | null {
  const todayYear = Number(today.slice(0, 4));
  for (const year of [todayYear, todayYear - 1]) {
    const elapsed = daysBetween(anniversaryIn(first, year), today);
    if (elapsed >= 0 && elapsed < WEEK_DAYS) {
      const years = year - Number(first.slice(0, 4));
      return years >= 1 ? years : null;
    }
  }
  return null;
}

function activityAnniversaryFact(input: TriviaCalendarInput): TriviaFact[] {
  const first = input.records?.firstTransactionDate;
  if (!first) return [];
  const elapsed = anniversaryYears(first, input.today);
  if (elapsed === null) return [];
  return [
    fact("activityAnniversary", "activity", {
      anniversaryYears: years(elapsed),
      anniversaryFirstDate: date(first),
    }),
  ];
}

function accountAnniversaryFact(input: TriviaCalendarInput): TriviaFact[] {
  const ledgerFirst = input.records?.firstTransactionDate;
  const accounts = input.calendar.accountFirstDates;
  // Without the ledger's first date there is no telling the two anniversaries apart.
  if (!ledgerFirst || !accounts) return [];

  // A brokerage pair shares one stripped name: it counts once, from its earlier date.
  const byName = new Map<string, string>();
  for (const { name, firstDate } of accounts) {
    const known = byName.get(name);
    if (known === undefined || firstDate < known) byName.set(name, firstDate);
  }
  const due = [...byName]
    .filter(([, firstDate]) => firstDate !== ledgerFirst)
    .map(([name, firstDate]) => ({
      name,
      firstDate,
      elapsed: anniversaryYears(firstDate, input.today),
    }))
    .filter(
      (row): row is typeof row & { elapsed: number } => row.elapsed !== null,
    )
    .sort(
      (a, b) =>
        a.firstDate.localeCompare(b.firstDate) || a.name.localeCompare(b.name),
    );
  const oldest = due[0];
  if (!oldest) return [];
  return [
    fact("activityAccountAnniversary", "activity", {
      anniversaryAccountName: text(oldest.name),
      anniversaryAccountYears: years(oldest.elapsed),
      anniversaryAccountSince: date(oldest.firstDate),
    }),
  ];
}

/** The largest {1, 2, 5} x 10^k at or above 1,000 that `latest` reached from below. */
function netWorthMilestoneFact(input: TriviaCalendarInput): TriviaFact[] {
  const { months, currency } = input;
  if (months.length < 3) return [];
  const [previous, latest] = months.slice(-2);
  // A ledger still being entered climbs from nothing: the month before must
  // hold a balance and must not be the series' first, or data entry would be
  // reported as a milestone (as `netWorthSinceStart` guards).
  if (previous.netWorth <= 0 || previous === months[0]) return [];
  if (previous.fxComplete === false || latest.fxComplete === false) return [];
  // "In {month}" is only true of a crossing between two consecutive months.
  if (monthsBetween(previous.month, latest.month) !== 1) return [];

  let reached: number | null = null;
  for (
    let magnitude = MIN_NET_WORTH_MILESTONE;
    magnitude <= latest.netWorth;
    magnitude *= 10
  ) {
    for (const step of NET_WORTH_STEPS) {
      const milestone = step * magnitude;
      if (previous.netWorth < milestone && milestone <= latest.netWorth) {
        reached = milestone;
      }
    }
  }
  if (reached === null) return [];
  return [
    fact("netWorthMilestone", "netWorth", {
      milestoneAmount: money(reached, currency),
      milestoneMonth: month(latest.month),
    }),
  ];
}

function transactionMilestoneFact(input: TriviaCalendarInput): TriviaFact[] {
  const before = input.calendar.transactionsRecordedBefore;
  const total = input.records?.transactions;
  if (before === null || total === undefined || total <= before) return [];
  const thousands =
    Math.floor(total / TRANSACTION_MILESTONE_STEP) * TRANSACTION_MILESTONE_STEP;
  const reached = [...TRANSACTION_MILESTONES, thousands]
    .filter((m) => m > 0 && before < m && m <= total)
    .sort((a, b) => b - a)[0];
  if (reached === undefined) return [];
  return [
    fact("activityTransactionMilestone", "activity", {
      transactionMilestone: count(reached),
    }),
  ];
}

function warrantyCountdownFact(input: TriviaCalendarInput): TriviaFact[] {
  const next = input.warranties?.nextExpiring;
  if (!next) return [];
  const remaining = daysBetween(input.today, next.expiresOn);
  if (remaining < MIN_WARRANTY_DAYS || remaining > MAX_WARRANTY_DAYS) return [];
  return [
    fact("warrantiesExpiresSoon", "warranties", {
      expiringWarrantyName: text(next.name),
      expiringWarrantyDays: days(remaining),
      expiringWarrantyDate: date(next.expiresOn),
    }),
  ];
}

/** The same month a year before `today`'s, first and last day. */
export function yearAgoMonthRange(today: string): {
  startDate: string;
  endDate: string;
} {
  const year = Number(today.slice(0, 4)) - 1;
  const monthNumber = Number(today.slice(5, 7));
  const key = `${year}-${String(monthNumber).padStart(2, "0")}`;
  return {
    startDate: `${key}-01`,
    endDate: getMonthEndYMD(year, monthNumber),
  };
}

function yearAgoSpendingFact(input: TriviaCalendarInput): TriviaFact[] {
  const report = input.calendar.yearAgoMonth;
  const first = input.records?.firstTransactionDate;
  if (!report || !first) return [];
  const total = report.totalSpending;
  if (total === null || total <= 0) return [];
  const { startDate } = yearAgoMonthRange(input.today);
  // A whole month of records: one that began mid-month says too little.
  if (first > startDate) return [];
  const top = [...report.data].sort((a, b) => b.total - a.total)[0];
  if (!top || top.categoryId === null) return [];
  return [
    fact("spendingYearAgoMonth", "spending", {
      yearAgoMonth: month(startDate),
      yearAgoSpent: money(total, report.currency),
      yearAgoTopCategoryName: text(top.categoryName),
    }),
  ];
}

function netWorthYearAgoFact(input: TriviaCalendarInput): TriviaFact[] {
  const { months, currency } = input;
  const latest = months[months.length - 1];
  if (!latest || latest.fxComplete === false) return [];
  const earlier = months.find(
    (m) => monthsBetween(m.month, latest.month) === 12,
  );
  if (!earlier || earlier.fxComplete === false) return [];
  const change = roundMoney(latest.netWorth - earlier.netWorth);
  if (change === 0) return [];
  return [
    fact(change > 0 ? "netWorthYearAgoUp" : "netWorthYearAgoDown", "netWorth", {
      yearAgoNetWorthMonth: month(earlier.month),
      yearAgoNetWorth: money(earlier.netWorth, currency),
      yearAgoNetWorthChange: money(Math.abs(change), currency),
    }),
  ];
}

/**
 * The facts that belong to a calendar moment (anniversaries, milestones, a
 * warranty countdown) and the year-ago comparisons. As elsewhere, a fact
 * exists only when every figure in it is known.
 */
export function buildCalendarTriviaFacts(
  input: TriviaCalendarInput,
): TriviaFact[] {
  return [
    ...activityAnniversaryFact(input),
    ...accountAnniversaryFact(input),
    ...netWorthMilestoneFact(input),
    ...transactionMilestoneFact(input),
    ...warrantyCountdownFact(input),
    ...yearAgoSpendingFact(input),
    ...netWorthYearAgoFact(input),
  ];
}
