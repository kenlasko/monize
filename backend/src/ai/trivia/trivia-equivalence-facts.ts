import { roundMoney } from "../../common/round.util";
import { daysBetween } from "../../common/time-series/price-boundary.util";
import type { PortfolioSummary } from "../../securities/portfolio.service";
import type { TriviaFact } from "./trivia.types";
import { completeFlows, type TriviaLedgerInput } from "./trivia-ledger-facts";
import { days, fact, money, multiple, text } from "./trivia-figures";
import { triviaWindow } from "./trivia-windows";

export interface TriviaEquivalenceInput {
  today: string;
  currency: string;
  /** The twelve whole months' reads. */
  ledger: TriviaLedgerInput;
  portfolio: PortfolioSummary | null;
}

/** A comparison under half of its unit is not worth saying. */
const MIN_RATIO = 0.5;

/** `x` rounded to two places, or `null` when it is not a ratio worth saying. */
function ratioOf(numerator: number, denominator: number): number | null {
  if (!(denominator > 0) || !(numerator > 0)) return null;
  const ratio = roundMoney(numerator / denominator, 2);
  return ratio >= MIN_RATIO ? ratio : null;
}

/** The biggest row with a real owner and a positive total. */
function topRow<T extends { total: number }>(
  rows: T[],
  named: (row: T) => boolean,
): T | null {
  return rows
    .filter((row) => named(row) && row.total > 0)
    .reduce<T | null>(
      (best, row) => (!best || row.total > best.total ? row : best),
      null,
    );
}

/**
 * Comparisons the model would like to make ("about two months of groceries")
 * but may not, since it writes no digit: each is worked out here from the
 * twelve-month data already read, and a ratio exists only when both operands
 * are known and the divisor is above zero.
 */
export function buildEquivalenceTriviaFacts(
  input: TriviaEquivalenceInput,
): TriviaFact[] {
  const { currency, ledger, portfolio, today } = input;
  const flows = completeFlows(ledger.incomeVsExpenses);
  if (!flows) return [];
  const expenses = flows.totals.expenses as number;
  const net = flows.totals.net as number;
  const months = flows.data.length;
  const spanDays =
    daysBetween(flows.data[0].periodStart, triviaWindow(today).endDate) + 1;
  const facts: TriviaFact[] = [];

  const category = ledger.spendingByCategory;
  const payee = ledger.spendingByPayee;
  if (
    category &&
    payee &&
    category.totalSpending !== null &&
    payee.totalSpending !== null
  ) {
    const topCategory = topRow(category.data, (r) => r.categoryId !== null);
    const topPayee = topRow(payee.data, (r) => r.payeeId !== null);
    const ratio =
      topCategory && topPayee
        ? ratioOf(topPayee.total, topCategory.total / months)
        : null;
    if (topCategory && topPayee && ratio !== null) {
      facts.push(
        fact("spendingPayeeInCategoryMonths", "spending", {
          equivPayeeName: text(topPayee.payeeName),
          equivPayeeAmount: money(topPayee.total, currency),
          equivCategoryName: text(topCategory.categoryName),
          equivCategoryMonths: multiple(ratio),
        }),
      );
    }
  }

  if (expenses > 0) {
    facts.push(
      fact("spendingDailyAverage", "spending", {
        dailyAverageSpent: money(expenses / spanDays, currency),
      }),
    );
    const covered = Math.floor((net * spanDays) / expenses);
    if (net > 0 && covered >= 1) {
      facts.push(
        fact("incomeKeptCoversDays", "income", {
          keptCoversAmount: money(net, currency),
          keptCoversDays: days(covered),
        }),
      );
    }
    if (
      portfolio &&
      portfolio.valuationComplete !== false &&
      portfolio.totalGainLoss !== null &&
      portfolio.totalGainLoss > 0 &&
      portfolio.gainCostBasis > 0
    ) {
      const ratio = ratioOf(portfolio.totalGainLoss, expenses / months);
      if (ratio !== null) {
        facts.push(
          fact("investmentsGainInMonthsOfSpending", "investments", {
            gainCoversAmount: money(portfolio.totalGainLoss, currency),
            gainCoversMonths: multiple(ratio),
          }),
        );
      }
    }
  }
  return facts;
}
