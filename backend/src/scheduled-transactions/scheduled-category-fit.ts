import { NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { fitCategories, fitCategory } from "../categories/category-fit";
import { lockCategoryOwnerShared } from "../common/db/locks";
import { tr } from "../i18n/translate";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";

interface OverrideCategories {
  readonly categoryId?: string | null;
  readonly splits?: readonly OverrideLineShape[] | null;
}

/**
 * The shared category-owner lock an override write takes as its first lock,
 * before the schedule's row lock (`common/db/locks.ts`), when it names a
 * category: whether a category row holds it is known only under that row
 * lock. The schedule's owner is read without a lock; it never changes.
 */
export async function lockOverrideCategoryOwner(
  m: EntityManager,
  scheduledTransactionId: string,
  override: OverrideCategories,
): Promise<void> {
  const namesCategory =
    Boolean(override.categoryId) ||
    (override.splits ?? []).some(
      (line) => !isInvestmentLine(line) && Boolean(line.categoryId),
    );
  if (!namesCategory) return;
  const owner = await m.getRepository(ScheduledTransaction).findOne({
    where: { id: scheduledTransactionId },
    select: { id: true, userId: true },
  });
  if (owner) await lockCategoryOwnerShared(m, owner.userId);
}

/**
 * What a schedule's override may hold (`docs/specs/transfer-categories.md`
 * section 4.3, INV-CATEGORY-001): its `categoryId` fits the schedule's kind (a
 * scheduled transfer takes any type, a scheduled ordinary transaction only
 * Income or Expense), and each split line fits its own kind (a transfer line
 * takes any type, a category line only Income or Expense). Each category is
 * the schedule owner's.
 *
 * The schedule is read under a share lock, so a concurrent switch of its kind
 * either commits first and is seen, or waits for this write. The caller takes
 * `lockOverrideCategoryOwner` first, before any row lock; the fits below take
 * the category-owner lock again, re-entrant.
 */
export async function fitOverrideCategories(
  m: EntityManager,
  scheduledTransactionId: string,
  override: OverrideCategories,
): Promise<void> {
  const schedule = await m.getRepository(ScheduledTransaction).findOne({
    where: { id: scheduledTransactionId },
    select: { id: true, userId: true, isTransfer: true },
    lock: { mode: "pessimistic_read" },
  });
  if (!schedule) {
    throw new NotFoundException(
      tr(
        "errors.scheduled.notFound",
        `Scheduled transaction with ID ${scheduledTransactionId} not found`,
        { id: scheduledTransactionId },
      ),
    );
  }
  await fitCategory(
    m,
    schedule.userId,
    override.categoryId,
    schedule.isTransfer === true ? "transfer" : "category",
  );
  await fitCategories(
    m,
    schedule.userId,
    (override.splits ?? [])
      .filter((line) => !isInvestmentLine(line))
      .map((line) => ({
        categoryId: line.categoryId,
        holder: line.transferAccountId ? "transfer" : "category",
      })),
  );
}

interface OverrideLineShape {
  readonly categoryId?: string | null;
  readonly transferAccountId?: string | null;
  readonly splitKind?: SplitKind | string | null;
  readonly investment?: unknown;
}

function isInvestmentLine(line: OverrideLineShape): boolean {
  return line.splitKind === SplitKind.INVESTMENT || !!line.investment;
}

/**
 * A schedule switching from a transfer to an ordinary transaction takes only
 * Income or Expense categories from then on (INV-CATEGORY-001), so a Transfer
 * category its overrides hold is cleared in the same write: the override's
 * own `category_id`, and the `categoryId` of every category line in its split
 * JSON. An Income or Expense category is kept. The database backstop checks
 * an override's `category_id` only when the override is written, which is why
 * the switch clears it here.
 */
export async function clearTransferCategoriesFromOverrides(
  m: EntityManager,
  userId: string,
  scheduledTransactionId: string,
): Promise<void> {
  await m.query(
    // category-fit-ok: clears a category that no longer fits, writes none
    `UPDATE scheduled_transaction_overrides o
        SET category_id = NULL
      WHERE o.scheduled_transaction_id = $1
        AND o.category_id IN (
          SELECT c.id FROM categories c
           WHERE c.user_id = $2 AND c.category_type = 'transfer')`,
    [scheduledTransactionId, userId],
  );
  await m.query(
    // category-fit-ok: clears a category that no longer fits, writes none
    `UPDATE scheduled_transaction_overrides o
        SET splits = (
          SELECT jsonb_agg(
                   CASE WHEN COALESCE(e->>'transferAccountId', '') = ''
                         AND e->>'categoryId' IN (
                           SELECT c.id::text FROM categories c
                            WHERE c.user_id = $2
                              AND c.category_type = 'transfer')
                        THEN jsonb_set(e, '{categoryId}', 'null'::jsonb)
                        ELSE e END
                   ORDER BY ord)
            FROM jsonb_array_elements(o.splits) WITH ORDINALITY AS t(e, ord))
      WHERE o.scheduled_transaction_id = $1
        AND jsonb_typeof(o.splits) = 'array'
        AND jsonb_array_length(o.splits) > 0`,
    [scheduledTransactionId, userId],
  );
}
