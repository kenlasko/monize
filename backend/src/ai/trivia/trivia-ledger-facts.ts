import type { SpendingByCategoryResponse } from "../../built-in-reports/dto/spending-by-category.dto";
import type { SpendingByPayeeResponse } from "../../built-in-reports/dto/spending-by-payee.dto";
import type { IncomeVsExpensesResponse } from "../../built-in-reports/dto/income-vs-expenses.dto";
import type { IncomeBySourceResponse } from "../../built-in-reports/dto/income-by-source.dto";
import type { TriviaFact } from "./trivia.types";
import { count, fact, money, month, percent, text } from "./trivia-figures";

/** The reader's records, counted. */
export interface TriviaRecordCounts {
  /** Non-VOID register rows, split children not counted apart from their parent. */
  transactions: number;
  /** `YYYY-MM-DD` of the oldest of them; `null` with none. */
  firstTransactionDate: string | null;
  activePayees: number;
  categories: number;
  activeScheduled: number;
}

/** The reader's warranties, as `warrantyStatus` reads them today. */
export interface TriviaWarranties {
  /** Not archived and not expired, lifetime ones included. */
  covered: number;
  /** The soonest a covered, non-lifetime warranty runs out. */
  nextExpiring: { name: string; expiresOn: string } | null;
}

/**
 * Everything the ledger can say over the window: the last twelve whole
 * months. The category, payee and source reports are read here for the ranked
 * facts (`buildRankedTriviaFacts`); this builder does not use them. Each source is `null` when it could not be read, which drops its
 * facts and only those.
 */
export interface TriviaLedgerInput {
  currency: string;
  spendingByCategory: SpendingByCategoryResponse | null;
  spendingByPayee: SpendingByPayeeResponse | null;
  incomeVsExpenses: IncomeVsExpensesResponse | null;
  incomeBySource: IncomeBySourceResponse | null;
  records: TriviaRecordCounts | null;
  warranties: TriviaWarranties | null;
}

/** Fewer months than this is not a year's picture of spending and saving. */
const MIN_WINDOW_MONTHS = 3;

function spendingFacts(input: TriviaLedgerInput): TriviaFact[] {
  const { currency } = input;
  const facts: TriviaFact[] = [];

  const flows = completeFlows(input.incomeVsExpenses);
  if (flows) {
    const biggest = flows.data.reduce<(typeof flows.data)[number] | null>(
      (best, row) =>
        row.expenses > 0 && (!best || row.expenses > best.expenses)
          ? row
          : best,
      null,
    );
    if (biggest) {
      facts.push(
        fact("spendingBiggestMonth", "spending", {
          biggestSpendMonth: month(biggest.periodStart),
          biggestSpendAmount: money(biggest.expenses, currency),
        }),
      );
    }
  }

  return facts;
}

/**
 * The window's months from the first one with any money in it, only when
 * every row converted. The report fills a month with nothing in it as zero,
 * so a ledger begun last month arrives as twelve months, eleven of them
 * empty; counted from its first active month it is one, and says nothing.
 */
function completeFlows(
  report: IncomeVsExpensesResponse | null,
): IncomeVsExpensesResponse | null {
  if (
    !report ||
    report.missingCurrencies.length > 0 ||
    report.totals.income === null ||
    report.totals.expenses === null ||
    report.totals.net === null
  ) {
    return null;
  }
  const first = report.data.findIndex(
    (row) => row.income !== 0 || row.expenses !== 0,
  );
  const data = first === -1 ? [] : report.data.slice(first);
  if (data.length < MIN_WINDOW_MONTHS) return null;
  return { ...report, data };
}

function incomeFacts(input: TriviaLedgerInput): TriviaFact[] {
  const { currency } = input;
  const facts: TriviaFact[] = [];

  const flows = completeFlows(input.incomeVsExpenses);
  if (flows) {
    const income = flows.totals.income as number;
    const net = flows.totals.net as number;
    if (income > 0 && net > 0) {
      facts.push(
        fact("incomeKeptShare", "income", {
          keptAmount: money(net, currency),
          keptPercent: percent((net / income) * 100),
        }),
      );
    }
    const surplus = flows.data.filter((row) => row.net > 0).length;
    if (surplus > 0) {
      facts.push(
        fact("incomeSurplusMonths", "income", {
          surplusMonths: count(surplus),
          windowMonths: count(flows.data.length),
        }),
      );
    }
  }

  return facts;
}

function activityFacts(input: TriviaLedgerInput): TriviaFact[] {
  const records = input.records;
  if (!records) return [];
  const facts: TriviaFact[] = [];
  if (records.transactions > 0 && records.firstTransactionDate) {
    facts.push(
      fact("activityTransactions", "activity", {
        transactionCount: count(records.transactions),
        firstTransactionMonth: month(records.firstTransactionDate),
      }),
    );
  }
  if (records.activePayees > 0 && records.categories > 0) {
    facts.push(
      fact("activityPayees", "activity", {
        payeeCount: count(records.activePayees),
        categoryCount: count(records.categories),
      }),
    );
  }
  if (records.activeScheduled > 0) {
    facts.push(
      fact("activityScheduled", "activity", {
        scheduledCount: count(records.activeScheduled),
      }),
    );
  }
  return facts;
}

function warrantyFacts(input: TriviaLedgerInput): TriviaFact[] {
  const warranties = input.warranties;
  if (!warranties || warranties.covered === 0) return [];
  const facts: TriviaFact[] = [
    fact("warrantiesCovered", "warranties", {
      warrantyCount: count(warranties.covered),
    }),
  ];
  if (warranties.nextExpiring) {
    facts.push(
      fact("warrantiesNextExpiry", "warranties", {
        nextWarrantyName: text(warranties.nextExpiring.name),
        nextWarrantyMonth: month(warranties.nextExpiring.expiresOn),
      }),
    );
  }
  return facts;
}

/**
 * The facts about the rest of the reader's Monize: where the money went and
 * came from over the last twelve months, how much they have recorded, and
 * what their warranties cover. As with net worth and investments, a fact
 * exists only when every figure in it is known.
 */
export function buildLedgerTriviaFacts(input: TriviaLedgerInput): TriviaFact[] {
  return [
    ...spendingFacts(input),
    ...incomeFacts(input),
    ...activityFacts(input),
    ...warrantyFacts(input),
  ];
}
