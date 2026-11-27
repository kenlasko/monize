/**
 * How deleting a schedule treats each column with a foreign key to
 * `scheduled_transactions(id)`:
 *  - `part`: the schedule's own splits, overrides and postings, and the
 *    payroll deduction rules that belong to a bill (INV-PAYROLL-001); they
 *    cascade with it.
 *  - `clear`: a loan account's link to its own payment schedule;
 *    `ScheduledTransactionsService.removeWithoutHistory` nulls it before the
 *    delete, so deleting the bill unlinks it from the loan.
 *
 * Keyed `table.column`; `scheduled-transaction-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the foreign keys disagree in
 * either direction, so a migration adding a reference names this map.
 */
export const SCHEDULED_TRANSACTION_REFERENCES = {
  "payroll_deduction_rules.scheduled_transaction_id": { policy: "part" },
  "accounts.scheduled_transaction_id": { policy: "clear" },
  "scheduled_transaction_splits.scheduled_transaction_id": { policy: "part" },
  "scheduled_transaction_overrides.scheduled_transaction_id": {
    policy: "part",
  },
  "scheduled_transaction_postings.scheduled_transaction_id": {
    policy: "part",
  },
} as const satisfies Record<string, { policy: "part" | "clear" }>;
