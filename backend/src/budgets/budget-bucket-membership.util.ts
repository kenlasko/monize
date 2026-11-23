import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
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
  if (isIncome) throw bucketOnIncomeLine();
  const bucket = await m
    .getRepository(BudgetBucket)
    .findOne({ where: { id: bucketId, budgetId } });
  if (!bucket) throw bucketNotFound(bucketId);
}

/**
 * `assertBucketAssignable` for a batch (the bulk line update): the same rule
 * and the same refusals, item by item in order, with the budget's named
 * buckets read in one query instead of one per line. It takes the write's
 * `EntityManager` for the same reason.
 */
export async function assertBucketsAssignable(
  m: EntityManager,
  budgetId: string,
  lines: ReadonlyArray<{ bucketId: string | null; isIncome: boolean }>,
): Promise<void> {
  const wanted = [
    ...new Set(
      lines.flatMap((line) =>
        line.bucketId !== null && !line.isIncome ? [line.bucketId] : [],
      ),
    ),
  ];
  const found =
    wanted.length === 0
      ? new Set<string>()
      : new Set(
          (
            await m.getRepository(BudgetBucket).find({
              where: { id: In(wanted), budgetId },
              select: { id: true },
            })
          ).map((bucket) => bucket.id),
        );
  for (const { bucketId, isIncome } of lines) {
    if (bucketId === null) continue;
    if (isIncome) throw bucketOnIncomeLine();
    if (!found.has(bucketId)) throw bucketNotFound(bucketId);
  }
}

function bucketOnIncomeLine(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.budgets.bucketOnIncomeLine",
      "An income line cannot belong to a bucket",
    ),
  );
}

function bucketNotFound(bucketId: string): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.budgets.bucketNotFound",
      `Bucket with ID ${bucketId} not found`,
      { id: bucketId },
    ),
  );
}
