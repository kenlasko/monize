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
 * check (`assertBudgetCreateUndoable`).
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
  if (action.entityType === "budget" && !isRedo && action.entityId) {
    await assertBudgetCreateUndoable(action, manager);
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

/**
 * Creating a budget makes the budget row alone. Its closed periods and lines
 * come later, so removing the budget would take rows the create never made
 * (and a redo cannot bring them back): the undo is refused before any write.
 */
async function assertBudgetCreateUndoable(
  action: ActionHistory,
  manager: EntityManager,
): Promise<void> {
  const rows = await manager.query(
    `SELECT b.name,
            (SELECT count(*)::int FROM budget_periods WHERE budget_id = b.id) AS periods,
            (SELECT count(*)::int FROM budget_categories WHERE budget_id = b.id) AS lines,
            (SELECT count(*)::int FROM budget_buckets WHERE budget_id = b.id) AS buckets
       FROM budgets b WHERE b.id = $1 AND b.user_id = $2 FOR UPDATE`,
    [action.entityId, action.userId],
  );
  const row = rows?.[0];
  if (!row || row.periods + row.lines + row.buckets === 0) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.undoBudgetHasHistory",
      `Cannot undo creating "${row.name}": it now has periods, category lines or buckets that were added after it. Delete the budget instead.`,
      { name: row.name },
    ),
    errorCode: "UNDO_BUDGET_HAS_HISTORY",
  });
}
