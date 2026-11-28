import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { findAccountReferences } from "../accounts/account-references";
import { findCategoryReferences } from "../categories/category-references";
import { findPayeeReferences } from "../payees/payee-references";
import { findSecurityReferences } from "../securities/security-references";
import { findTagReferences } from "../tags/tag-references";
import {
  RecordInUseEntry,
  recordInUseException,
  recordInUseSummary,
} from "../common/helpers/record-in-use";
import { ActionHistory } from "./entities/action-history.entity";

type Finder = (
  m: EntityManager,
  userId: string,
  id: string,
) => Promise<RecordInUseEntry[]>;

/**
 * Entities whose row removal would clear or destroy rows that point at it.
 * `custom_report` is absent: its children are part of it. A budget has its own
 * check (`assertBudgetRemovable`).
 * The account's finder counts the loan's own schedule too, so an account undo
 * never drops a schedule that still pays into it. (Loan and mortgage creation
 * records only the schedule's entry today, so this guards a future one.)
 */
const REFERENCE_CHECKS: Record<
  string,
  { table: string; label?: string; find: Finder; skipOnRedo?: boolean }
> = {
  category: { table: "categories", find: findCategoryReferences },
  payee: { table: "payees", find: findPayeeReferences },
  // Deleting a tag removes it everywhere on purpose (PR #2378), so its redo is
  // not refused; only the undo of a create is.
  tag: { table: "tags", find: findTagReferences, skipOnRedo: true },
  account: {
    table: "accounts",
    find: (m, userId, id) =>
      findAccountReferences(m, userId, id, { includeOwnSchedule: true }),
  },
  // Named by symbol, as errors.securities.inUse and the UI do.
  security: {
    table: "securities",
    label: "symbol",
    find: findSecurityReferences,
  },
};

/**
 * Before an undo of a create (or the redo of a delete) removes the row: lock it
 * and refuse, with the counts, while other rows use it. Runs in the undo's
 * transaction before any write, so a refusal leaves the entry undoable later.
 * A row that is already gone has nothing to check.
 */
export async function assertNoReferencesBeforeDelete(
  action: ActionHistory,
  manager: EntityManager,
  isRedo: boolean,
): Promise<void> {
  if (action.entityType === "budget" && action.entityId) {
    await assertBudgetRemovable(action, manager, isRedo);
    return;
  }
  const check = REFERENCE_CHECKS[action.entityType];
  if (!check || !action.entityId || (isRedo && check.skipOnRedo)) return;
  // `table` and `label` come from the map above, never from the request.
  const rows: { name?: string }[] = await manager.query(
    `SELECT ${check.label ?? "name"} AS name FROM ${check.table} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [action.entityId, action.userId],
  );
  if (!rows?.length) return;
  const references = await check.find(manager, action.userId, action.entityId);
  if (references.length === 0) return;
  const name = rows[0].name ?? "";
  const summary = recordInUseSummary(references);
  throw recordInUseException(
    isRedo
      ? tr(
          "errors.actionHistory.redoDeleteInUse",
          `Cannot redo deleting "${name}": it is now used by ${summary}. Remove these first.`,
          { name, summary },
        )
      : tr(
          "errors.actionHistory.undoCreateInUse",
          `Cannot undo creating "${name}": it is now used by ${summary}. Remove these first.`,
          { name, summary },
        ),
    references,
  );
}

/** The columns of a restored line or bucket a person can edit: [column, snapshot key]. */
const LINE_FIELDS: [string, string][] = [
  ["category_id", "categoryId"],
  ["transfer_account_id", "transferAccountId"],
  ["is_transfer", "isTransfer"],
  ["category_group", "categoryGroup"],
  ["amount", "amount"],
  ["is_income", "isIncome"], // income-flag-ok: the line's own direction column
  ["rollover_type", "rolloverType"],
  ["rollover_cap", "rolloverCap"],
  ["flex_group", "flexGroup"],
  ["alert_warn_percent", "alertWarnPercent"],
  ["alert_critical_percent", "alertCriticalPercent"],
  ["notes", "notes"],
  ["sort_order", "sortOrder"],
  ["bucket_id", "bucketId"],
];
const BUCKET_FIELDS: [string, string][] = [
  ["name", "name"],
  ["target_type", "targetType"],
  ["target_value", "targetValue"],
  ["carry_over", "carryOver"],
  ["carry_cap", "carryCap"],
  ["sort_order", "sortOrder"],
];

/** Numeric columns come back as text and a snapshot holds numbers: compare the numbers; every other column as it is. */
const NUMERIC_COLUMNS = new Set([
  "amount",
  "rollover_cap",
  "target_value",
  "carry_cap",
  "alert_warn_percent",
  "alert_critical_percent",
  "sort_order",
]);
const comparable = (column: string, v: unknown): unknown =>
  v === undefined || v === null
    ? null
    : NUMERIC_COLUMNS.has(column)
      ? Number(v)
      : v;

/**
 * How many of `rows` (the table's current rows) the snapshot does not hold
 * or holds with other values: a row added, or edited, after the restore. A
 * null reference where the snapshot has an id that no longer exists (`gone`)
 * is the foreign key's SET NULL, not an edit.
 */
function changedRows(
  rows: Record<string, unknown>[],
  snapshot: unknown,
  key: string,
  fields: [string, string][],
  gone: Set<string>,
): number {
  const held = (snapshot as Record<string, unknown> | null)?.[key];
  const byId = new Map<string, Record<string, unknown>>(
    Array.isArray(held)
      ? held.map((r) => [
          (r as { id: string }).id,
          r as Record<string, unknown>,
        ])
      : [],
  );
  return rows.filter((row) => {
    const was = byId.get(row.id as string);
    return (
      !was ||
      fields.some(([column, field]) => {
        const now = comparable(column, row[column]);
        const before = comparable(column, was[field]);
        if (now === before) return false;
        return !(now === null && gone.has(before as string));
      })
    );
  }).length;
}

/** The categories and accounts a snapshot's lines name that no longer exist. */
async function goneReferences(
  manager: EntityManager,
  userId: string,
  snapshot: unknown,
): Promise<Set<string>> {
  const held = (snapshot as Record<string, unknown> | null)?.categories;
  const lines = Array.isArray(held) ? held : [];
  const named = (field: string): string[] =>
    lines.map((l) => l?.[field]).filter((v): v is string => !!v);
  const gone = new Set<string>();
  for (const [table, ids] of [
    ["categories", named("categoryId")],
    ["accounts", named("transferAccountId")],
  ] as const) {
    if (ids.length === 0) continue;
    const alive: { id: string }[] = await manager.query(
      `SELECT id FROM ${table} WHERE user_id = $1 AND id = ANY($2)`,
      [userId, ids],
    );
    const live = new Set(alive.map((r) => r.id));
    ids.filter((id) => !live.has(id)).forEach((id) => gone.add(id));
  }
  return gone;
}

/**
 * Removing a budget cascades to its periods, lines and buckets, so the undo of
 * its create (which made the budget row alone) and the redo of its delete are
 * refused, before any write, while rows the action did not account for exist.
 * The lock is its own statement and the counts a second one: under READ
 * COMMITTED a count in the locking statement would miss a line or a close that
 * committed while the lock waited (CONC-011). Every period counts, open ones
 * too: it keeps the cascade out of the picture and the message true. Budget
 * notifications (`notifications.budget_id` cascades) are not counted: they are
 * alerts the alert service derives again from the budget, not a record the
 * user made.
 *
 * A redo of a delete expects the lines and buckets its snapshot restored
 * (`afterData` once inverted), with the values it held: one edited since would
 * be deleted and the next undo would bring the old values back. Periods are
 * never restored, so any is new. shortcut: the budget row itself is not
 * compared (a rename after the restore is lost), upgrade if that matters.
 */
async function assertBudgetRemovable(
  action: ActionHistory,
  manager: EntityManager,
  isRedo: boolean,
): Promise<void> {
  const locked: { name: string }[] = await manager.query(
    `SELECT name FROM budgets WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [action.entityId, action.userId],
  );
  if (!locked?.length) return;
  const [{ periods }] = await manager.query(
    `SELECT count(*)::int AS periods FROM budget_periods WHERE budget_id = $1`,
    [action.entityId],
  );
  const lines: Record<string, unknown>[] = await manager.query(
    `SELECT * FROM budget_categories WHERE budget_id = $1`,
    [action.entityId],
  );
  const buckets: Record<string, unknown>[] = await manager.query(
    `SELECT * FROM budget_buckets WHERE budget_id = $1`,
    [action.entityId],
  );
  // The undo of a create expects none (the snapshot holds the row alone).
  const snapshot = isRedo ? action.afterData : null;
  const gone = isRedo
    ? await goneReferences(manager, action.userId, snapshot)
    : new Set<string>();
  const added =
    Number(periods) +
    changedRows(lines, snapshot, "categories", LINE_FIELDS, gone) +
    changedRows(buckets, snapshot, "buckets", BUCKET_FIELDS, gone);
  if (added === 0) return;
  const name = locked[0].name;
  throw new ConflictException(
    isRedo
      ? {
          message: tr(
            "errors.actionHistory.redoBudgetHasHistory",
            `Cannot redo deleting "${name}": it now has periods, category lines or buckets that were added or changed after it was restored. Delete the budget instead.`,
            { name },
          ),
          errorCode: "REDO_BUDGET_HAS_HISTORY",
        }
      : {
          message: tr(
            "errors.actionHistory.undoBudgetHasHistory",
            `Cannot undo creating "${name}": it now has periods, category lines or buckets that were added after it. Delete the budget instead.`,
            { name },
          ),
          errorCode: "UNDO_BUDGET_HAS_HISTORY",
        },
  );
}
