import type { EntityManager } from "typeorm";
import { accrualErrors } from "../accruals/accrual-errors";
import { LEDGER_TOP_LEVEL_ONLY } from "../common/ledger-balance.sql";
import type { ImportContext } from "./import-context";

const prepared = new WeakMap<
  EntityManager,
  { userId: string; ids: Set<string> }
>();
/** Import entry points call this after holdings advisory locks, before any row writes. */
export async function prepareImportAccrualSources(
  m: EntityManager,
  userId: string,
): Promise<Set<string>> {
  const previous = prepared.get(m);
  if (previous) {
    if (previous.userId !== userId) throw accrualErrors.conflict();
    return previous.ids;
  }
  const parents: { id: string }[] = await m.query(
    `SELECT t.id FROM transactions t WHERE t.user_id=$1 AND ${LEDGER_TOP_LEVEL_ONLY} AND NOT EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=t.id) ORDER BY t.id FOR UPDATE`,
    [userId],
  );
  const legs: { id: string }[] = await m.query(
    `SELECT t.id FROM transactions t WHERE t.user_id=$1 AND (NOT (${LEDGER_TOP_LEVEL_ONLY}) OR EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=t.id)) ORDER BY t.id FOR UPDATE`,
    [userId],
  );
  const ids = new Set([...parents, ...legs].map((row) => row.id));
  prepared.set(m, { userId, ids });
  return ids;
}

/** Existing matches and placeholders cannot lose/reprice an accrual without review. */
export async function assertImportAccrualIds(
  m: EntityManager,
  userId: string,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  const frozen = await prepareImportAccrualSources(m, userId);
  const selected = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (selected.some((id) => !frozen.has(id))) throw accrualErrors.conflict();
  if (!selected.length) return;
  const schedules: { id: string }[] = await m.query(
    `SELECT a.id FROM accrual_schedules a JOIN transactions t ON t.id=a.source_transaction_id
     WHERE a.user_id=$1 AND (t.id=ANY($2::uuid[]) OR t.id IN
       (SELECT parent_transaction_id FROM transactions WHERE user_id=$1 AND id=ANY($2::uuid[])))
     LIMIT 1`,
    [userId, selected],
  );
  if (schedules.length) throw accrualErrors.conflict();
}

export async function assertImportAccrualMatch(
  ctx: ImportContext,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  return assertImportAccrualIds(ctx.manager, ctx.userId, ids);
}
/** Only call immediately after saving a newly created source in this import. */
export function rememberImportedAccrualSource(
  m: EntityManager,
  userId: string,
  id: string,
): void {
  const state = prepared.get(m);
  if (state?.userId === userId) state.ids.add(id);
}

/** Review the date's transfer match cohort before creating payees or source rows. */
export async function assertImportAccrualEntry(
  ctx: ImportContext,
  row: {
    date: string;
    isTransfer?: boolean;
    category?: string;
    splits?: {
      isTransfer?: boolean;
      transferAccount?: string;
      category?: string;
    }[];
  },
): Promise<void> {
  const transfer =
    row.isTransfer ||
    (row.category && ctx.loanCategoryMap.has(row.category)) ||
    row.splits?.some(
      (line) =>
        line.isTransfer ||
        line.transferAccount ||
        (line.category && ctx.loanCategoryMap.has(line.category)),
    );
  if (!transfer) return;
  const candidates: { id: string; linked: string | null }[] =
    await ctx.manager.query(
      "SELECT id,linked_transaction_id AS linked FROM transactions WHERE user_id=$1 AND transaction_date=$2 AND is_transfer=true ORDER BY id",
      [ctx.userId, row.date],
    );
  await assertImportAccrualMatch(
    ctx,
    candidates.flatMap((candidate) => [candidate.id, candidate.linked]),
  );
}
