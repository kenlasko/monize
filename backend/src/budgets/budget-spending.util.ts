import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetCategory } from "./entities/budget-category.entity";

/**
 * Queries transaction and split spending for budget categories within a period.
 * Returns maps of categoryId -> totalSpent and transferAccountId -> totalSpent.
 *
 * Shared between BudgetsService and BudgetAlertService to avoid duplication.
 */
export async function queryCategorySpending(
  transactionsRepository: Repository<Transaction>,
  splitsRepository: Repository<TransactionSplit>,
  userId: string,
  budgetCategories: BudgetCategory[],
  periodStart: string,
  periodEnd: string,
): Promise<{
  spendingMap: Map<string, number>;
  transferSpendingMap: Map<string, number>;
}> {
  const categoryIds = budgetCategories
    .filter((bc) => bc.categoryId !== null)
    .map((bc) => bc.categoryId as string);

  const spendingMap = new Map<string, number>();
  const transferSpendingMap = new Map<string, number>();
  const transferBudgetCategories = budgetCategories.filter(
    (bc) => bc.isTransfer && bc.transferAccountId,
  );

  // Run all independent queries in parallel
  const queries: Promise<void>[] = [];

  if (categoryIds.length > 0) {
    queries.push(
      transactionsRepository
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .groupBy("t.category_id")
        .getRawMany()
        .then((rows) => {
          for (const row of rows) {
            spendingMap.set(row.categoryId, parseFloat(row.total || "0"));
          }
        }),
    );

    queries.push(
      splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("s.category_id")
        .getRawMany()
        .then((rows) => {
          for (const row of rows) {
            const existing = spendingMap.get(row.categoryId) || 0;
            spendingMap.set(
              row.categoryId,
              existing + parseFloat(row.total || "0"),
            );
          }
        }),
    );
  }

  if (transferBudgetCategories.length > 0) {
    const transferAccountIds = transferBudgetCategories.map(
      (bc) => bc.transferAccountId as string,
    );

    queries.push(
      transactionsRepository
        .createQueryBuilder("t")
        .innerJoin("t.linkedTransaction", "lt")
        .select("lt.account_id", "destinationAccountId")
        .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.is_transfer = true")
        .andWhere("t.amount < 0")
        .andWhere("lt.account_id IN (:...transferAccountIds)", {
          transferAccountIds,
        })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("lt.account_id")
        .getRawMany()
        .then((rows) => {
          for (const row of rows) {
            transferSpendingMap.set(
              row.destinationAccountId,
              parseFloat(row.total || "0"),
            );
          }
        }),
    );
  }

  await Promise.all(queries);

  return { spendingMap, transferSpendingMap };
}

/** Resolves the display name for a budget category. */
export function resolveCategoryName(bc: BudgetCategory): string {
  if (bc.isTransfer && bc.transferAccountId) {
    return bc.transferAccount?.name || "Transfer";
  }
  const cat = bc.category;
  return cat
    ? cat.parent
      ? `${cat.parent.name}: ${cat.name}`
      : cat.name
    : "Uncategorized";
}

/** Resolves the actual spent amount for a budget category from the spending maps. */
export function resolveCategorySpent(
  bc: BudgetCategory,
  spendingMap: Map<string, number>,
  transferSpendingMap: Map<string, number>,
): number {
  if (bc.isTransfer && bc.transferAccountId) {
    return transferSpendingMap.get(bc.transferAccountId) || 0;
  }
  return bc.categoryId ? spendingMap.get(bc.categoryId) || 0 : 0;
}
