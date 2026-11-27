import { categoryTypeOfOrUndefined } from "../categories/category-type.util";
import { sumMoney } from "../common/round.util";
import { BudgetCategory } from "./entities/budget-category.entity";

/**
 * A budget's income as three figures (docs/specs/transfer-categories.md
 * section 6.2). Split by line, not by row: an income line on an Income or
 * Expense category is Actual Income even where transfers feed it.
 *
 * - **Actual Income** (`categoryIncome`): the actuals of the income lines that
 *   name an Income or Expense category.
 * - **Transfer Funding** (`transferFunding`): the actuals of the transfer
 *   income lines (per account, issue #2141) and of the income lines that name
 *   a Transfer category, plus the `transfersInAsIncome` figure.
 * - **Total Budget Funding** (`totalIncome`): the two together, the figure the
 *   summary has always called `totalIncome` and the period close stores as
 *   `actual_income`, unchanged for a budget with no Transfer category line.
 */
export interface BudgetFunding {
  categoryIncome: number;
  transferFunding: number;
  totalIncome: number;
}

/** What a line says about whether its actual is Transfer Funding. */
type FundingLine = Pick<
  BudgetCategory,
  "isIncome" | "isTransfer" | "transferAccountId"
> & {
  category?: Parameters<typeof categoryTypeOfOrUndefined>[0];
};

/**
 * Whether an income line funds the budget by transfer: a per-account transfer
 * income line, or a line on a Transfer category. An outgoing line never is.
 */
export function isTransferFundingLine(line: FundingLine): boolean {
  if (!line.isIncome) return false;
  if (line.isTransfer && line.transferAccountId) return true;
  return categoryTypeOfOrUndefined(line.category) === "transfer";
}

/**
 * The three figures from each income line's actual (clamped, as the summary
 * reads it) and the toggle's figure. Each is the single rounding of its own
 * parts, and the total is the sum of all of them, as it was before.
 */
export function budgetFunding(
  incomeLines: readonly { actual: number; isTransferFunding: boolean }[],
  outsideTransferIncome: number,
): BudgetFunding {
  const actuals = (transfer: boolean) =>
    incomeLines
      .filter((line) => line.isTransferFunding === transfer)
      .map((line) => line.actual);
  return {
    categoryIncome: sumMoney(actuals(false)),
    transferFunding: sumMoney([...actuals(true), outsideTransferIncome]),
    totalIncome: sumMoney([
      ...incomeLines.map((line) => line.actual),
      outsideTransferIncome,
    ]),
  };
}
