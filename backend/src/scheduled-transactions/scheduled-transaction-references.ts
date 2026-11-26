import { EntityManager } from "typeorm";
import { RecordInUseEntry } from "../common/helpers/record-in-use";

/** What blocks deleting a schedule: one entry per kind of row still using it. */
export type ScheduledTransactionReferenceKind =
  "payrollDeductionRules" | "loanAccounts";

/**
 * How deleting a schedule treats each column with a foreign key to
 * `scheduled_transactions(id)`:
 *  - `refuse`: counted; any row blocks the delete (409 RECORD_IN_USE). A loan
 *    account's own schedule is unlinked (`accounts.scheduled_transaction_id`
 *    cleared) by `AccountsService.delete` before it removes the schedule, so
 *    that path sees no row here.
 *  - `part`: the schedule's own splits, overrides and postings; they cascade
 *    with it and are not counted.
 *
 * Keyed `table.column`; `scheduled-transaction-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the foreign keys disagree in
 * either direction, so a migration adding a reference names this map.
 */
export const SCHEDULED_TRANSACTION_REFERENCES = {
  "payroll_deduction_rules.scheduled_transaction_id": {
    policy: "refuse",
    kind: "payrollDeductionRules",
  },
  "accounts.scheduled_transaction_id": {
    policy: "refuse",
    kind: "loanAccounts",
  },
  "scheduled_transaction_splits.scheduled_transaction_id": { policy: "part" },
  "scheduled_transaction_overrides.scheduled_transaction_id": {
    policy: "part",
  },
  "scheduled_transaction_postings.scheduled_transaction_id": {
    policy: "part",
  },
} as const satisfies Record<
  string,
  | { policy: "refuse"; kind: ScheduledTransactionReferenceKind }
  | { policy: "part" }
>;

/**
 * Every kind of row that still uses the schedule, with a count above zero. Run
 * inside the delete's transaction, after locking the schedule row. Loan
 * accounts report their ids so the client can link to them.
 */
export async function findScheduledTransactionReferences(
  m: EntityManager,
  userId: string,
  scheduledTransactionId: string,
): Promise<RecordInUseEntry[]> {
  const found: RecordInUseEntry[] = [];
  const [rules]: { count?: number }[] = await m.query(
    "SELECT count(*)::int AS count FROM payroll_deduction_rules WHERE user_id = $1 AND scheduled_transaction_id = $2",
    [userId, scheduledTransactionId],
  );
  if (Number(rules?.count) > 0) {
    found.push({ kind: "payrollDeductionRules", count: Number(rules.count) });
  }
  const loans: { id: string }[] = await m.query(
    "SELECT id FROM accounts WHERE user_id = $1 AND scheduled_transaction_id = $2",
    [userId, scheduledTransactionId],
  );
  if (loans.length > 0) {
    found.push({
      kind: "loanAccounts",
      count: loans.length,
      ids: loans.map((r) => r.id),
    });
  }
  return found;
}
