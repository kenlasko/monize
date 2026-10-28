import { requireAccrualOwner } from "../accruals/accrual-source";
import { createHash } from "node:crypto";
import { In, type EntityManager } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import type { UpdatePayeeDto } from "./dto/update-payee.dto";
import { lockPayeeSources, type PayeeSourceRow } from "./payee-source-metadata";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import {
  resolveBulkAccrualEdit,
  type BulkAccrualPreview,
} from "../accruals/accrual-bulk-edit";
import { canonical } from "../accruals/accrual-source-edit";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import { accrualErrors } from "../accruals/accrual-errors";

interface CategorySourceRow {
  id: string;
  categoryId: string | null;
  isSplit: boolean;
  isTransfer: boolean;
  status: string;
  snapshot: string;
}
export interface PayeeCategoryEdit {
  sources: PayeeSourceRow[];
  categoryId: string | null;
  mode: "none" | "uncategorized" | "all";
  preview: BulkAccrualPreview;
}

/** Both preview and commit resolve here, before any payee/source write. */
export async function preparePayeeCategoryEdit(
  m: EntityManager,
  userId: string,
  payeeId: string,
  dto: UpdatePayeeDto,
  context?: {
    sources: PayeeSourceRow[];
    command: unknown;
    projectedPayeeId?: string;
  },
): Promise<PayeeCategoryEdit> {
  const sources =
    context?.sources ?? (await lockPayeeSources(m, userId, [payeeId]));
  // Source rows precede the payee row, matching rename/merge ordering.
  const payees: { defaultCategoryId: string | null; snapshot: string }[] =
    await m.query(
      `SELECT default_category_id AS "defaultCategoryId",to_jsonb(p)::text AS snapshot
     FROM payees p WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [payeeId, userId],
    );
  if (!payees[0]) throw accrualErrors.missing();
  const categoryId =
    dto.defaultCategoryId !== undefined
      ? dto.defaultCategoryId
      : payees[0].defaultCategoryId;
  const mode = dto.applyCategoryToTransactions ?? "none";
  // Keep the proposed category family stable through preview resolution and refresh.
  if (categoryId) {
    const owned = await m.query(
      "SELECT id FROM categories WHERE id=$1 AND user_id=$2 FOR SHARE",
      [categoryId, userId],
    );
    if (!owned[0]) throw accrualErrors.missing();
  }
  const rows: CategorySourceRow[] = sources.length
    ? await m.query(
        `SELECT id,category_id AS "categoryId",is_split AS "isSplit",
     is_transfer AS "isTransfer",status,to_jsonb(t)::text AS snapshot
     FROM transactions t WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
        [userId, sources.map((row) => row.id)],
      )
    : [];
  const selected =
    !categoryId || mode === "none"
      ? []
      : rows.filter(
          (row) =>
            !row.isSplit &&
            !row.isTransfer &&
            (mode === "all" || row.categoryId === null),
        );
  await assertReconciledRowsMutable(m, userId, selected);
  const ids = selected.map((row) => row.id);
  const preview = categoryId
    ? await resolveBulkAccrualEdit(
        m,
        userId,
        ids,
        new Set(),
        {
          mode: "ids",
          transactionIds: ids,
          categoryId,
          ...(context?.projectedPayeeId
            ? { payeeId: context.projectedPayeeId }
            : {}),
          ...(dto.name !== undefined ? { payeeName: dto.name } : {}),
        },
        undefined,
      )
    : { fingerprint: null, transactionIds: ids, impacts: [] };
  if (preview.impacts.length) requireAccrualOwner(userId);
  if (preview.fingerprint) {
    const { accrualImpactFingerprint: _ignored, ...input } = dto;
    preview.fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            version: "payee-category-edit-v1",
            userId,
            payeeId,
            input,
            command: context?.command,
            payee: payees[0].snapshot,
            sources: rows.map((row) => [row.id, row.snapshot]),
            categoryId,
            mode,
            accrual: preview.fingerprint,
          }),
        ),
      )
      .digest("hex");
  }
  return { sources, categoryId, mode, preview };
}

/** Applies only the frozen selection and joins schedule refresh to the write. */
export async function applyPayeeCategoryEdit(
  m: EntityManager,
  userId: string,
  payeeId: string,
  edit: PayeeCategoryEdit,
): Promise<number> {
  const ids = edit.preview.transactionIds;
  if (!ids.length || !edit.categoryId) return 0;
  const result = await m.update(
    Transaction,
    { userId, payeeId, id: In(ids), isSplit: false, isTransfer: false },
    { categoryId: edit.categoryId },
  );
  for (const impact of edit.preview.impacts)
    await refreshSourceAccruals(m, userId, impact.transactionId);
  return result.affected ?? 0;
}
