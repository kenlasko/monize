import type { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import type { SpendingByCategoryResponse } from "../../built-in-reports/dto/spending-by-category.dto";
import type { SpendingByPayeeResponse } from "../../built-in-reports/dto/spending-by-payee.dto";
import type { IncomeBySourceResponse } from "../../built-in-reports/dto/income-by-source.dto";
import { mapWithConcurrency } from "../../common/concurrency.util";
import type { TriviaFamily } from "./trivia-families";
import { pickRank, pickWindow, windowRange } from "./trivia-windows";
import type { TriviaWindow } from "./trivia.types";

/** The families whose window (and, for the ranked ones, rank) rotate. */
export const WINDOWED_FAMILIES = [
  "spendingTopCategory",
  "spendingTopPayee",
  "incomeTopSource",
  "spendingRankedCategory",
  "spendingRankedPayee",
  "incomeRankedSource",
] as const satisfies readonly TriviaFamily[];
export type WindowedFamily = (typeof WINDOWED_FAMILIES)[number];

/** What each windowed family describes this week, chosen before any read. */
export type TriviaPicks = Record<
  WindowedFamily,
  { window: TriviaWindow; rank: 2 | 3 }
>;

export function pickAll(userId: string, today: string): TriviaPicks {
  const entries = WINDOWED_FAMILIES.map((family) => [
    family,
    {
      window: pickWindow(userId, family, today),
      rank: pickRank(userId, family, today),
    },
  ]);
  return Object.fromEntries(entries) as TriviaPicks;
}

/** One report's reads, by window; `m12` is not here, the loader reads it anyway. */
export type WindowedRead<T> = Map<TriviaWindow, T | null>;

export interface TriviaWindowedReads {
  spendingByCategory: WindowedRead<SpendingByCategoryResponse>;
  spendingByPayee: WindowedRead<SpendingByPayeeResponse>;
  incomeBySource: WindowedRead<IncomeBySourceResponse>;
}

export const emptyWindowedReads = (): TriviaWindowedReads => ({
  spendingByCategory: new Map(),
  spendingByPayee: new Map(),
  incomeBySource: new Map(),
});

type Attempt = <T>(source: string, read: () => Promise<T>) => Promise<T | null>;

/** The distinct windows the picks of some families need, `m12` excluded. */
function windowsOf(
  picks: TriviaPicks,
  families: readonly WindowedFamily[],
): TriviaWindow[] {
  return [...new Set(families.map((f) => picks[f].window))].filter(
    (w) => w !== "m12",
  );
}

/**
 * Reads each `(report, window)` the picks need exactly once: two families
 * that picked the same window share one report call. Each report call opens
 * its own transaction, so at most `limit` run at once.
 */
export async function readWindowedReports(
  reports: BuiltInReportsService,
  attempt: Attempt,
  userId: string,
  today: string,
  picks: TriviaPicks,
  limit: number,
): Promise<TriviaWindowedReads> {
  const out = emptyWindowedReads();
  const jobs = <T>(
    into: WindowedRead<T>,
    source: string,
    windows: TriviaWindow[],
    call: (start: string | undefined, end: string) => Promise<T>,
  ): (() => Promise<void>)[] =>
    windows.map((window) => async () => {
      const { startDate, endDate } = windowRange(window, today);
      into.set(
        window,
        await attempt(`${source} (${window})`, () => call(startDate, endDate)),
      );
    });
  await mapWithConcurrency(
    [
      ...jobs(
        out.spendingByCategory,
        "spending",
        windowsOf(picks, ["spendingTopCategory", "spendingRankedCategory"]),
        (s, e) => reports.getSpendingByCategory(userId, s, e),
      ),
      ...jobs(
        out.spendingByPayee,
        "payees",
        windowsOf(picks, ["spendingTopPayee", "spendingRankedPayee"]),
        (s, e) => reports.getSpendingByPayee(userId, s, e),
      ),
      ...jobs(
        out.incomeBySource,
        "income",
        windowsOf(picks, ["incomeTopSource", "incomeRankedSource"]),
        (s, e) => reports.getIncomeBySource(userId, s, e),
      ),
    ],
    limit,
    (run) => run(),
  );
  return out;
}
