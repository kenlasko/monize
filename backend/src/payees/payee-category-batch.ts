import { createHash } from "node:crypto";
import { In, type EntityManager } from "typeorm";
import { Payee } from "./entities/payee.entity";
import { lockPayeeSources } from "./payee-source-metadata";
import {
  preparePayeeCategoryEdit,
  type PayeeCategoryEdit,
} from "./payee-category-impact";
import type { CategorySuggestionAssignmentDto } from "./dto/apply-category-suggestions.dto";
import type { BulkAccrualPreview } from "../accruals/accrual-bulk-edit";
import { canonical } from "../accruals/accrual-source-edit";
import { accrualErrors } from "../accruals/accrual-errors";

/** Freeze all sources before any payee/category row lock, across the entire batch. */
export async function lockPayeeCategoryBatch(
  m: EntityManager,
  userId: string,
  payeeIds: readonly string[],
  categoryIds: readonly string[],
) {
  const ids = [...new Set(payeeIds)].sort();
  const sources = await lockPayeeSources(m, userId, ids);
  const payees: { id: string; snapshot: string }[] = ids.length
    ? await m.query(
        `SELECT id,to_jsonb(p)::text AS snapshot FROM payees p
   WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [userId, ids],
      )
    : [];
  // Payee locks block new referencing inserts. Detect any row committed while
  // those locks were queued, before deleting/merging a payee with an incomplete set.
  const current: { id: string }[] = ids.length
    ? await m.query(
        "SELECT id FROM transactions WHERE user_id=$1 AND payee_id=ANY($2::uuid[]) ORDER BY id",
        [userId, ids],
      )
    : [];
  if (
    JSON.stringify(current.map((row) => row.id)) !==
    JSON.stringify(sources.map((row) => row.id))
  )
    throw accrualErrors.conflict();
  const categories = [...new Set(categoryIds)].sort();
  const owned: { id: string }[] = categories.length
    ? await m.query(
        "SELECT id FROM categories WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
        [userId, categories],
      )
    : [];
  if (owned.length !== categories.length) throw accrualErrors.missing();
  const snapshots: { id: string; snapshot: string }[] = sources.length
    ? await m.query(
        `SELECT id,to_jsonb(t)::text AS snapshot FROM transactions t
   WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
        [userId, sources.map((row) => row.id)],
      )
    : [];
  return { sources, payees, snapshots };
}

export async function prepareSuggestionCategoryBatch(
  m: EntityManager,
  userId: string,
  assignments: readonly CategorySuggestionAssignmentDto[],
) {
  if (
    new Set(assignments.map((row) => row.payeeId)).size !== assignments.length
  )
    throw accrualErrors.conflict();
  const locked = await lockPayeeCategoryBatch(
    m,
    userId,
    assignments.map((row) => row.payeeId),
    assignments.map((row) => row.categoryId),
  );
  const present = new Set(locked.payees.map((row) => row.id));
  const payees = present.size
    ? await m.find(Payee, { where: { userId, id: In([...present]) } })
    : [];
  const available = new Set(payees.map((row) => row.id));
  const plans: { payeeId: string; edit: PayeeCategoryEdit }[] = [];
  for (const assignment of [...assignments].sort((a, b) =>
    a.payeeId.localeCompare(b.payeeId),
  )) {
    if (!available.has(assignment.payeeId)) continue; // Existing suggestion batches skip missing payees.
    const edit = await preparePayeeCategoryEdit(
      m,
      userId,
      assignment.payeeId,
      {
        defaultCategoryId: assignment.categoryId,
        applyCategoryToTransactions: assignment.backfillTransactions
          ? "uncategorized"
          : "none",
      },
      {
        sources: locked.sources.filter(
          (row) => row.payeeId === assignment.payeeId,
        ),
        command: assignments,
      },
    );
    plans.push({ payeeId: assignment.payeeId, edit });
  }
  const preview: BulkAccrualPreview = {
    fingerprint: null,
    transactionIds: plans
      .flatMap((plan) => plan.edit.preview.transactionIds)
      .sort(),
    impacts: plans.flatMap((plan) => plan.edit.preview.impacts),
  };
  if (preview.impacts.length)
    preview.fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            version: "payee-suggestion-category-batch-v1",
            userId,
            assignments,
            payees: locked.payees,
            sources: locked.snapshots,
            plans: plans.map((plan) => ({
              payeeId: plan.payeeId,
              preview: plan.edit.preview,
            })),
          }),
        ),
      )
      .digest("hex");
  return { plans, payees, preview };
}
