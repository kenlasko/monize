import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { BudgetBucket } from "./entities/budget-bucket.entity";

/**
 * The one membership check of INV-BUDGET-002 (docs/future-plans/bucket-budget.md
 * truth table D). A budget line may carry `bucketId` only when it is a
 * non-income line and the bucket is one of the SAME budget. It takes the
 * caller's transaction `EntityManager` so the check and the write that follows
 * share one transaction: every writer of `budget_categories.bucket_id` (line add,
 * line update, bulk update, the wizard apply) calls this before it writes.
 *
 * `bucketId === null` always passes (a cleared line is never a violation, even
 * an income line). A bucket of another budget or another person's is read as
 * missing: the budget scope in the predicate plus row-level security make both
 * the same 404, so a refusal does not reveal that the id exists.
 */
export async function assertBucketAssignable(
  m: EntityManager,
  budgetId: string,
  bucketId: string | null,
  isIncome: boolean,
): Promise<void> {
  if (bucketId === null) return;
  if (isIncome) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketOnIncomeLine",
        "An income line cannot belong to a bucket",
      ),
    );
  }
  const bucket = await m
    .getRepository(BudgetBucket)
    .findOne({ where: { id: bucketId, budgetId } });
  if (!bucket) {
    throw new NotFoundException(
      tr(
        "errors.budgets.bucketNotFound",
        `Bucket with ID ${bucketId} not found`,
        { id: bucketId },
      ),
    );
  }
}
