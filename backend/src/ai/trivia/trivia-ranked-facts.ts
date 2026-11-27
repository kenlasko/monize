import type { SpendingByCategoryResponse } from "../../built-in-reports/dto/spending-by-category.dto";
import type { SpendingByPayeeResponse } from "../../built-in-reports/dto/spending-by-payee.dto";
import type { IncomeBySourceResponse } from "../../built-in-reports/dto/income-by-source.dto";
import type { TriviaFact, TriviaWindow } from "./trivia.types";
import { count, fact, money, percent, text } from "./trivia-figures";
import type {
  TriviaPicks,
  TriviaWindowedReads,
  WindowedFamily,
} from "./trivia-windowed-reads";

/** The twelve whole months' reads, which the legacy ids describe. */
export interface TriviaM12Reads {
  spendingByCategory: SpendingByCategoryResponse | null;
  spendingByPayee: SpendingByPayeeResponse | null;
  incomeBySource: IncomeBySourceResponse | null;
}

export interface TriviaRankedInput {
  currency: string;
  picks: TriviaPicks;
  windowed: TriviaWindowedReads;
  m12: TriviaM12Reads;
}

type Source = "spendingByCategory" | "spendingByPayee" | "incomeBySource";

/** The read a family's picked window describes: the m12 one, or the windowed one. */
function readOf<S extends Source>(
  input: TriviaRankedInput,
  source: S,
  family: WindowedFamily,
): { read: TriviaM12Reads[S]; window: TriviaWindow } {
  const { window } = input.picks[family];
  const read =
    window === "m12"
      ? input.m12[source]
      : (input.windowed[source].get(window) ?? null);
  return { read: read as TriviaM12Reads[S], window };
}

/** Only m12 is the legacy fact; any other window says its window. */
const paramsOf = (window: TriviaWindow) =>
  window === "m12" ? undefined : { window };

interface Row {
  name: string;
  total: number;
}

type RowWithShare = Row & { percentage: number };

/**
 * A report total is a total only with every currency converted (null
 * otherwise): a share of a partial sum would be a share of nothing the reader
 * can see, so a null or zero total gives no fact.
 */
function categoryRows(
  report: SpendingByCategoryResponse | null,
): RowWithShare[] {
  const total = report?.totalSpending ?? null;
  if (!report || total === null || total <= 0) return [];
  return report.data
    .filter((r) => r.categoryId !== null && r.total > 0)
    .flatMap((r) => {
      const percentage = report.netSpending
        ? r.percentage
        : (r.total / total) * 100;
      return percentage === undefined
        ? []
        : [{ name: r.categoryName, total: r.total, percentage }];
    })
    .sort((a, b) => b.total - a.total);
}

function payeeRows(
  report: SpendingByPayeeResponse | null,
): { rows: Row[]; total: number } | null {
  const total = report?.totalSpending ?? null;
  if (!report || total === null || total <= 0) return null;
  return {
    total,
    rows: report.data
      // A row with no payee is the report's "Unknown" bucket, not a payee.
      .filter((r) => r.payeeId !== null && r.total > 0)
      .map((r) => ({ name: r.payeeName, total: r.total }))
      .sort((a, b) => b.total - a.total),
  };
}

function sourceRows(
  report: IncomeBySourceResponse | null,
): { rows: RowWithShare[]; total: number } | null {
  const total = report?.totalIncome ?? null;
  if (!report || total === null || total <= 0) return null;
  return {
    total,
    rows: report.data
      .flatMap((r) =>
        r.categoryId !== null && r.total > 0 && r.percentage !== null
          ? [{ name: r.categoryName, total: r.total, percentage: r.percentage }]
          : [],
      )
      .sort((a, b) => b.total - a.total),
  };
}

function spendingFacts(input: TriviaRankedInput): TriviaFact[] {
  const { currency } = input;
  const facts: TriviaFact[] = [];

  const topCategory = readOf(
    input,
    "spendingByCategory",
    "spendingTopCategory",
  );
  const top = categoryRows(topCategory.read)[0];
  if (top) {
    facts.push(
      fact(
        topCategory.window === "m12"
          ? "spendingTopCategory"
          : "spendingTopCategoryWindow",
        "spending",
        {
          topCategoryName: text(top.name),
          topCategoryAmount: money(top.total, currency),
          topCategoryPercent: percent(top.percentage),
        },
        paramsOf(topCategory.window),
      ),
    );
  }

  const topPayee = readOf(input, "spendingByPayee", "spendingTopPayee");
  const payees = payeeRows(topPayee.read);
  if (payees?.rows[0]) {
    const top = payees.rows[0];
    facts.push(
      fact(
        topPayee.window === "m12"
          ? "spendingTopPayee"
          : "spendingTopPayeeWindow",
        "spending",
        {
          topPayeeName: text(top.name),
          topPayeeAmount: money(top.total, currency),
        },
        paramsOf(topPayee.window),
      ),
    );
  }

  const rankedCategory = readOf(
    input,
    "spendingByCategory",
    "spendingRankedCategory",
  );
  const categoryRank = input.picks.spendingRankedCategory.rank;
  const pickedCategory = categoryRows(rankedCategory.read)[categoryRank - 1];
  if (pickedCategory) {
    facts.push(
      fact(
        "spendingRankedCategory",
        "spending",
        {
          rankedCategoryName: text(pickedCategory.name),
          rankedCategoryRank: count(categoryRank),
          rankedCategoryAmount: money(pickedCategory.total, currency),
          rankedCategoryPercent: percent(pickedCategory.percentage),
        },
        { window: rankedCategory.window },
      ),
    );
  }

  const rankedPayee = readOf(input, "spendingByPayee", "spendingRankedPayee");
  const rankedPayees = payeeRows(rankedPayee.read);
  const payeeRank = input.picks.spendingRankedPayee.rank;
  const pickedPayee = rankedPayees?.rows[payeeRank - 1];
  if (pickedPayee) {
    facts.push(
      fact(
        "spendingRankedPayee",
        "spending",
        {
          rankedPayeeName: text(pickedPayee.name),
          rankedPayeeRank: count(payeeRank),
          rankedPayeeAmount: money(pickedPayee.total, currency),
        },
        { window: rankedPayee.window },
      ),
    );
  }

  return facts;
}

function incomeFacts(input: TriviaRankedInput): TriviaFact[] {
  const facts: TriviaFact[] = [];

  const topSource = readOf(input, "incomeBySource", "incomeTopSource");
  const sources = sourceRows(topSource.read);
  if (sources?.rows[0]) {
    const top = sources.rows[0];
    facts.push(
      fact(
        topSource.window === "m12"
          ? "incomeTopSource"
          : "incomeTopSourceWindow",
        "income",
        {
          topSourceName: text(top.name),
          topSourcePercent: percent(top.percentage),
        },
        paramsOf(topSource.window),
      ),
    );
  }

  const rankedSource = readOf(input, "incomeBySource", "incomeRankedSource");
  const rankedSources = sourceRows(rankedSource.read);
  const sourceRank = input.picks.incomeRankedSource.rank;
  const pickedSource = rankedSources?.rows[sourceRank - 1];
  if (rankedSources && pickedSource) {
    facts.push(
      fact(
        "incomeRankedSource",
        "income",
        {
          rankedSourceName: text(pickedSource.name),
          rankedSourceRank: count(sourceRank),
          rankedSourcePercent: percent(pickedSource.percentage),
        },
        { window: rankedSource.window },
      ),
    );
  }

  return facts;
}

/**
 * The top and ranked spending and income facts, over the window and rank each
 * family picked for the week. One fact per family: the choice was made before
 * anything was read, so there is never an instance to choose among.
 */
export function buildRankedTriviaFacts(input: TriviaRankedInput): TriviaFact[] {
  return [...spendingFacts(input), ...incomeFacts(input)];
}
