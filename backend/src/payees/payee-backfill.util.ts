import { EntityManager, IsNull } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";

/**
 * "Backfillable" transactions are the ones that would receive a payee's default
 * category when backfilling: they have no category yet, are not transfers, and
 * are not split parents (whose categories live on the split lines). Limiting to
 * these rows means an existing manual categorization is never overwritten.
 */
function backfillableWhere(userId: string, payeeId: string) {
  return {
    userId,
    payeeId,
    categoryId: IsNull(),
    isTransfer: false,
    isSplit: false,
  };
}

/**
 * Count, per payee, how many transactions a default-category backfill would
 * touch. Returns a map keyed by payee id; payees with zero such transactions
 * are absent from the map. A single grouped query covers every payee.
 */
export async function countUncategorizedTransactionsByPayee(
  manager: EntityManager,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await manager
    .createQueryBuilder(Transaction, "t")
    .select("t.payee_id", "payeeId")
    .addSelect("COUNT(*)", "cnt")
    .where("t.user_id = :userId", { userId })
    .andWhere("t.payee_id IS NOT NULL")
    .andWhere("t.category_id IS NULL")
    .andWhere("t.is_transfer = false")
    .andWhere("t.is_split = false")
    .groupBy("t.payee_id")
    .getRawMany<{ payeeId: string; cnt: string }>();

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.payeeId, parseInt(row.cnt, 10));
  }
  return map;
}

/**
 * Assign `categoryId` to a single payee's backfillable transactions (see
 * `backfillableWhere`). Returns the number of transactions updated. Pass the
 * EntityManager from an active QueryRunner so the backfill joins the caller's
 * transaction.
 */
export async function backfillPayeeCategory(
  manager: EntityManager,
  userId: string,
  payeeId: string,
  categoryId: string,
): Promise<number> {
  const result = await manager.update(
    Transaction,
    backfillableWhere(userId, payeeId),
    { categoryId },
  );
  return result.affected ?? 0;
}
