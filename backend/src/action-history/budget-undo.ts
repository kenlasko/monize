import { EntityManager } from "typeorm";
import { ActionHistory } from "./entities/action-history.entity";

export const BUDGET_BUCKET_COLUMNS = new Set([
  "id",
  "budget_id",
  "name",
  "target_type",
  "target_value",
  "carry_over",
  "carry_cap",
  "sort_order",
  "created_at",
  "updated_at",
]);
export const BUDGET_LINE_COLUMNS = new Set([
  "id",
  "budget_id",
  "category_id",
  "transfer_account_id",
  "is_transfer",
  "category_group",
  "amount",
  // income-flag-ok: the budget line's own direction column, not a category type
  "is_income",
  "rollover_type",
  "rollover_cap",
  "flex_group",
  "alert_warn_percent",
  "alert_critical_percent",
  "notes",
  "sort_order",
  "created_at",
  "updated_at",
  "bucket_id",
]);

const COLUMNS: Record<string, Set<string>> = {
  budget_buckets: BUDGET_BUCKET_COLUMNS,
  budget_categories: BUDGET_LINE_COLUMNS,
};
const toSnake = (str: string): string =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The snapshot of a deleted budget holds its buckets and lines (the periods
 * cascaded away and are not recorded). Buckets go first: a line points at
 * one. A category or account deleted since is cleared on the line, as the
 * foreign key's SET NULL would have done had the budget stayed. The
 * referents are locked (FOR KEY SHARE) before the decision, so one deleted
 * between the read and the insert cannot fail the insert (CONC-011).
 */
export async function restoreBudgetChildren(
  manager: EntityManager,
  action: ActionHistory,
  insert: (table: string, row: Record<string, any>) => Promise<void>,
): Promise<void> {
  const snapshot = action.beforeData as Record<string, any>;
  const buckets: Record<string, any>[] = snapshot?.buckets ?? [];
  const lines: Record<string, any>[] = snapshot?.categories ?? [];
  const alive = async (table: string, ids: string[]): Promise<Set<string>> =>
    new Set(
      ids.length === 0
        ? []
        : (
            await manager.query(
              `SELECT id FROM ${table} WHERE user_id = $1 AND id = ANY($2) FOR KEY SHARE`,
              [action.userId, ids],
            )
          ).map((r: { id: string }) => r.id),
    );
  const pick = (row: Record<string, any>, table: string) =>
    Object.fromEntries(
      Object.entries(row).filter(([k]) => COLUMNS[table].has(toSnake(k))),
    );
  for (const bucket of buckets) {
    await insert("budget_buckets", {
      ...pick(bucket, "budget_buckets"),
      budgetId: action.entityId,
    });
  }
  const categories = await alive(
    "categories",
    lines.map((l) => l.categoryId).filter(Boolean),
  );
  const accounts = await alive(
    "accounts",
    lines.map((l) => l.transferAccountId).filter(Boolean),
  );
  for (const line of lines) {
    await insert("budget_categories", {
      ...pick(line, "budget_categories"),
      budgetId: action.entityId,
      categoryId: categories.has(line.categoryId) ? line.categoryId : null,
      transferAccountId: accounts.has(line.transferAccountId)
        ? line.transferAccountId
        : null,
    });
  }
}
