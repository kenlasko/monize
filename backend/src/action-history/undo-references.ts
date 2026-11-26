import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { findAccountReferences } from "../accounts/account-references";
import { findCategoryReferences } from "../categories/category-references";
import { findPayeeReferences } from "../payees/payee-references";
import { findScheduledTransactionReferences } from "../scheduled-transactions/scheduled-transaction-references";
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
 * `budget` and `custom_report` are absent: their children are part of them.
 * The account's finder counts the loan's own schedule too: that schedule is a
 * separate, newer history entry, undone first.
 */
const REFERENCE_CHECKS: Record<string, { table: string; find: Finder }> = {
  category: { table: "categories", find: findCategoryReferences },
  payee: { table: "payees", find: findPayeeReferences },
  tag: { table: "tags", find: findTagReferences },
  account: {
    table: "accounts",
    find: (m, userId, id) =>
      findAccountReferences(m, userId, id, { includeOwnSchedule: true }),
  },
  scheduled_transaction: {
    table: "scheduled_transactions",
    // The loan's link to its own payment schedule is cleared by the undo.
    find: (m, userId, id) =>
      findScheduledTransactionReferences(m, userId, id, {
        includeLoanLink: false,
      }),
  },
  security: { table: "securities", find: findSecurityReferences },
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
  const check = REFERENCE_CHECKS[action.entityType];
  if (!check || !action.entityId) return;
  // `table` comes from the map above, never from the request.
  const rows: { name?: string }[] = await manager.query(
    `SELECT name FROM ${check.table} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
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
