import { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import type { LockedTransactionRow } from "../common/db/locks";
import { assertReconciledIdsMutable } from "./reconciled-lock.util";

/**
 * One category per transfer (INV-CATEGORY-002,
 * `docs/specs/transfer-categories.md` sections 1 and 4.8): a category write on
 * one side of a transfer sets the other side too.
 *
 * - `leg`: the other leg of a plain transfer, when the same person owns it.
 * - `line`: the split's transfer line whose linked row the written row is.
 *
 * Across two owners there is no partner: the other leg is another person's,
 * its category is theirs, and the writer's leg is the only one written.
 */
export type CategoryPartner =
  | { readonly kind: "leg"; readonly id: string }
  | { readonly kind: "line"; readonly id: string; readonly parentId: string };

/** What a partner held before a write and holds after it, for the history. */
export interface CategoryPartnerRecord {
  readonly kind: CategoryPartner["kind"];
  readonly id: string;
  readonly parentId?: string;
  readonly categoryId: string | null;
}

/** A history snapshot's `categoryPartner`, as `writeCategoryPartner` recorded it. */
export function isCategoryPartnerRecord(
  value: unknown,
): value is CategoryPartnerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "leg" || record.kind === "line") &&
    typeof record.id === "string" &&
    (record.categoryId === null || typeof record.categoryId === "string")
  );
}

interface RowShape {
  readonly id: string;
  readonly isTransfer?: boolean | null;
  readonly linkedTransactionId?: string | null;
}

/**
 * The other side of a transfer row, read without a lock: the caller locks it
 * with the row, in the order `common/db/locks.ts` sets (a split parent before
 * its legs, a transfer's two legs ascending), before it reads or writes a
 * category. `null` for an ordinary row, a split parent, and a leg whose other
 * leg is another person's or gone.
 */
export async function findCategoryPartner(
  m: EntityManager,
  userId: string,
  row: RowShape,
): Promise<CategoryPartner | null> {
  if (row.isTransfer !== true) return null;
  const [line] = (await m.query(
    `SELECT s.id, s.transaction_id AS "parentId"
       FROM transaction_splits s
       JOIN transactions p ON p.id = s.transaction_id
      WHERE s.linked_transaction_id = $1 AND p.user_id = $2`,
    [row.id, userId],
  )) as { id: string; parentId: string }[];
  if (line) return { kind: "line", id: line.id, parentId: line.parentId };
  if (!row.linkedTransactionId) return null;
  const [leg] = (await m.query(
    `SELECT id FROM transactions
      WHERE id = $1 AND user_id = $2 AND is_transfer = true
        AND linked_transaction_id = $3`,
    [row.linkedTransactionId, userId, row.id],
  )) as { id: string }[];
  return leg ? { kind: "leg", id: leg.id } : null;
}

/**
 * Set the partner to `categoryId`, when it holds another: a value difference,
 * not a field being present. Runs after the caller fitted the category (a
 * transfer row takes any type) and under the locks above. Returns what the
 * partner held before and after, or `null` when nothing was written.
 */
export async function writeCategoryPartner(
  m: EntityManager,
  userId: string,
  partner: CategoryPartner | null,
  categoryId: string | null,
): Promise<{
  readonly before: CategoryPartnerRecord;
  readonly after: CategoryPartnerRecord;
} | null> {
  if (!partner) return null;
  const held = await readPartnerCategory(m, userId, partner);
  if (held === undefined || held === categoryId) return null;
  // The other side is written too, so it answers the strict reconciled lock
  // as the row does: the other leg, or the parent a line belongs to (as
  // updateTransfer refuses a reconciled mirror).
  await assertReconciledIdsMutable(m, userId, [
    partner.kind === "leg" ? partner.id : partner.parentId,
  ]);
  await restoreCategoryPartner(m, userId, { ...partner, categoryId });
  const record = {
    kind: partner.kind,
    id: partner.id,
    ...(partner.kind === "line" ? { parentId: partner.parentId } : {}),
  };
  return {
    before: { ...record, categoryId: held },
    after: { ...record, categoryId },
  };
}

/** The category the partner holds; `undefined` when it is gone. */
async function readPartnerCategory(
  m: EntityManager,
  userId: string,
  partner: CategoryPartner,
): Promise<string | null | undefined> {
  const rows = (await (partner.kind === "leg"
    ? m.query(
        `SELECT category_id FROM transactions WHERE id = $1 AND user_id = $2`,
        [partner.id, userId],
      )
    : m.query(
        `SELECT s.category_id FROM transaction_splits s
           JOIN transactions p ON p.id = s.transaction_id
          WHERE s.id = $1 AND p.user_id = $2`,
        [partner.id, userId],
      ))) as { category_id: string | null }[];
  return rows.length === 0 ? undefined : rows[0].category_id;
}

/**
 * Lock the rows an undo or redo restores together with the other sides of
 * transfers it returns, in the order the forward write took them
 * (`common/db/locks.ts`): the split parent of each partner line before any
 * row, then the rows and the other legs together, ascending. Returns the
 * locked rows, the other legs among them.
 */
export async function lockRowsWithCategoryPartners(
  m: EntityManager,
  userId: string,
  rowIds: readonly string[],
  records: readonly CategoryPartnerRecord[],
): Promise<Map<string, LockedTransactionRow>> {
  const parentIds: string[] = [];
  for (const record of records) {
    if (record.kind !== "line") continue;
    const parentId = record.parentId ?? (await lineParentOf(m, record.id));
    if (parentId) parentIds.push(parentId);
  }
  if (parentIds.length > 0) await lockTransactionRows(m, parentIds, userId);
  return lockTransactionRows(
    m,
    [
      ...rowIds,
      ...records.filter((r) => r.kind === "leg").map((record) => record.id),
    ],
    userId,
  );
}

/**
 * An undo or redo returning the other side of a transfer to the value its
 * history recorded. The other side answers the strict reconciled lock as the
 * forward write did (the other leg, or the parent a line belongs to), so an
 * undo cannot reach a row the edit itself could not.
 */
export async function undoCategoryPartner(
  m: EntityManager,
  userId: string,
  record: CategoryPartnerRecord,
): Promise<void> {
  const owner =
    record.kind === "leg"
      ? record.id
      : (record.parentId ?? (await lineParentOf(m, record.id)));
  if (owner) await assertReconciledIdsMutable(m, userId, [owner]);
  await restoreCategoryPartner(m, userId, record);
}

async function lineParentOf(
  m: EntityManager,
  lineId: string,
): Promise<string | null> {
  const [row] = (await m.query(
    `SELECT transaction_id AS "parentId" FROM transaction_splits WHERE id = $1`,
    [lineId],
  )) as { parentId: string }[];
  return row?.parentId ?? null;
}

/**
 * Write a partner's category: the write above, and an undo restoring the
 * value its history recorded. `transaction_splits` has no `user_id`, so a
 * line is scoped through its parent.
 */
export async function restoreCategoryPartner(
  m: EntityManager,
  userId: string,
  record: Pick<CategoryPartnerRecord, "kind" | "id" | "categoryId">,
): Promise<void> {
  if (record.kind === "leg") {
    await m.query(
      // category-fit-ok: the other leg of a transfer, which takes any type
      `UPDATE transactions SET category_id = $1
        WHERE id = $2 AND user_id = $3 AND is_transfer = true`,
      [record.categoryId, record.id, userId],
    );
    return;
  }
  await m.query(
    // category-fit-ok: a split's transfer line, which takes any type
    `UPDATE transaction_splits SET category_id = $1
      WHERE id = $2 AND transfer_account_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE t.id = transaction_splits.transaction_id
                       AND t.user_id = $3)`,
    [record.categoryId, record.id, userId],
  );
}
