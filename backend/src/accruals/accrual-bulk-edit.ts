import { createHash } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { BulkUpdateDto } from "../transactions/dto/bulk-update.dto";
import type { UpdateTransactionDto } from "../transactions/dto/update-transaction.dto";
import {
  canonical,
  resolveSourceAccrualEdit,
  type AccrualEditResolution,
} from "./accrual-source-edit";
import { accrualErrors } from "./accrual-errors";

export interface BulkAccrualPreview {
  fingerprint: string | null;
  transactionIds: string[];
  impacts: {
    transactionId: string;
    schedules: AccrualEditResolution["impacts"];
  }[];
}

/** Caller holds every source lock; never round-trip stored split money through Number. */
export async function resolveBulkAccrualEdit(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
  splitParents: ReadonlySet<string>,
  dto: BulkUpdateDto,
  restriction: readonly string[] | undefined,
): Promise<BulkAccrualPreview> {
  const transactionIds = [...new Set(ids)].sort();
  const { accrualImpactFingerprint: _ignored, ...input } = dto;
  const patch: Partial<UpdateTransactionDto> = {};
  for (const key of [
    "categoryId",
    "payeeId",
    "payeeName",
    "description",
    "status",
    "tagIds",
  ] as const) {
    if (key in dto) Object.assign(patch, { [key]: dto[key] });
  }
  const impacts: BulkAccrualPreview["impacts"] = [];
  const signatures: { id: string; fingerprint: string | null }[] = [];
  // One query identifies accrued sources; ordinary legacy batches need no per-row reads.
  const accrued: { id: string; isSplit: boolean }[] = transactionIds.length
    ? await m.query(
        'SELECT DISTINCT a.source_transaction_id AS id,t.is_split AS "isSplit" FROM accrual_schedules a JOIN transactions t ON t.id=a.source_transaction_id WHERE a.user_id=$1 AND a.source_transaction_id=ANY($2)',
        [userId, transactionIds],
      )
    : [];
  for (const row of accrued) {
    if (row.isSplit !== splitParents.has(row.id))
      throw accrualErrors.conflict();
  }
  const accruedIds = new Set(accrued.map((row) => row.id));
  for (const id of transactionIds) {
    if (!accruedIds.has(id)) continue;
    const sourcePatch = { ...patch };
    const splitCategories = new Map<string, string | null>();
    if (splitParents.has(id)) {
      delete sourcePatch.categoryId;
      if ("categoryId" in dto) {
        const lines: { id: string; category_id: string | null }[] =
          await m.query(
            "SELECT s.id,s.category_id FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id WHERE t.user_id=$1 AND t.id=$2 AND s.kind='category' ORDER BY s.id",
            [userId, id],
          );
        for (const line of lines) {
          if (
            restriction === undefined ||
            (line.category_id !== null &&
              restriction.includes(line.category_id))
          ) {
            splitCategories.set(line.id, dto.categoryId ?? null);
          }
        }
      }
    }
    const resolution = await resolveSourceAccrualEdit(
      m,
      userId,
      id,
      sourcePatch,
      splitCategories,
    );
    signatures.push({ id, fingerprint: resolution.fingerprint });
    if (resolution.impacts.length)
      impacts.push({ transactionId: id, schedules: resolution.impacts });
  }
  const fingerprint = impacts.length
    ? createHash("sha256")
        .update(
          JSON.stringify(
            canonical({
              version: "accrual-bulk-edit-v1",
              userId,
              input,
              transactionIds,
              signatures,
              impacts,
              restriction:
                restriction === undefined ? null : [...restriction].sort(),
            }),
          ),
        )
        .digest("hex")
    : null;
  return { fingerprint, transactionIds, impacts };
}

export function verifyBulkAccrualEdit(
  preview: BulkAccrualPreview,
  expected?: string,
): void {
  if (
    preview.fingerprint
      ? preview.fingerprint !== expected
      : expected !== undefined
  ) {
    throw accrualErrors.conflict();
  }
}
