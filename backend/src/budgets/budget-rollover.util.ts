import { EntityManager, In, Not } from "typeorm";
import { MONEY_SCALE, sumMoney } from "../common/round.util";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";

/** A period grants its line's allocation plus the signed carry received at opening. */
export function effectiveLineBudget(
  allocation: number,
  rolloverIn = 0,
): number {
  return rolloverIn === 0
    ? allocation
    : sumMoney([allocation, rolloverIn], MONEY_SCALE);
}

/** The carry posted at opening survives a later change to the line's outgoing rollover setting. */
export async function loadExpenseRolloverIn(
  manager: EntityManager,
  budget: Budget,
  periodStart: string,
): Promise<ReadonlyMap<string, number>> {
  const ids = (budget.categories ?? [])
    .filter((line) => !line.isIncome)
    .map((line) => line.id);
  if (!ids.length) return new Map();
  const rows = await manager.getRepository(BudgetPeriodCategory).find({
    select: { budgetCategoryId: true, rolloverIn: true },
    where: {
      budgetPeriod: { budgetId: budget.id, periodStart },
      budgetCategoryId: In(ids),
      rolloverIn: Not(0),
    },
  });
  return new Map(
    rows.map((row) => [row.budgetCategoryId, Number(row.rolloverIn)]),
  );
}
