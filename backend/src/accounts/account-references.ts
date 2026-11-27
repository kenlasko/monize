import { EntityManager } from "typeorm";
import {
  RecordInUseEntry,
  ReferenceCount,
  countReferences,
} from "../common/helpers/record-in-use";
import { countSchedulesReferencingAccounts } from "./account-schedule-references";

/** What blocks deleting an account: one entry per kind of row still using it. */
export type AccountReferenceKind =
  | "transactions"
  | "investmentTransactions"
  | "holdings"
  | "scheduledTransactions"
  | "budgetLines"
  | "bankSyncLinks"
  | "sharedIntegrations"
  | "gemStrategies"
  | "linkedAccounts"
  | "rules"
  | "customReports"
  | "monteCarloScenarios"
  | "investmentReports";

/**
 * How deleting an account treats each column with a foreign key to
 * `accounts(id)`:
 *  - `refuse`: counted; any row blocks the delete (409 RECORD_IN_USE). The
 *    schema's CASCADE or SET NULL would destroy or orphan it silently.
 *    `holdings.account_id` is refused only while the position is nonzero.
 *    The scheduled-transaction columns leave out a loan's own payment
 *    schedule, which `AccountsService.delete` removes itself.
 *  - `part`: the account's own bookkeeping; it goes with the account.
 *  - `clear`: `AccountsService.delete` nulls the investment pair's link.
 *
 * Keyed `table.column`; `account-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the foreign keys disagree in
 * either direction, so a migration adding a reference names this map.
 */
export const ACCOUNT_REFERENCES = {
  "transactions.account_id": {
    policy: "refuse",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transactions WHERE user_id = $1 AND account_id = $2",
  },
  "transaction_splits.transfer_account_id": {
    policy: "refuse",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.user_id = $1 AND s.transfer_account_id = $2",
  },
  // A record read: includes VOID, a VOID row is still a row the delete destroys.
  "investment_transactions.account_id": {
    policy: "refuse",
    kind: "investmentTransactions",
    sql: "SELECT count(*)::int AS count FROM investment_transactions WHERE user_id = $1 AND account_id = $2",
  },
  // A record read: includes VOID, a VOID row is still a row the delete destroys.
  "investment_transactions.funding_account_id": {
    policy: "refuse",
    kind: "investmentTransactions",
    sql: "SELECT count(*)::int AS count FROM investment_transactions WHERE user_id = $1 AND funding_account_id = $2",
  },
  "holdings.account_id": {
    policy: "refuse",
    kind: "holdings",
    sql: "SELECT count(*)::int AS count FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE a.user_id = $1 AND h.account_id = $2 AND ABS(h.quantity) > 0.00000001",
  },
  "scheduled_transactions.account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    counted: "schedules",
  },
  "scheduled_transactions.transfer_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    counted: "schedules",
  },
  "scheduled_transactions.investment_funding_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    counted: "schedules",
  },
  "scheduled_transaction_splits.transfer_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    counted: "schedules",
  },
  "budget_categories.transfer_account_id": {
    policy: "refuse",
    kind: "budgetLines",
    sql: "SELECT count(*)::int AS count FROM budget_categories c JOIN budgets b ON b.id = c.budget_id WHERE b.user_id = $1 AND c.transfer_account_id = $2",
  },
  "bank_sync_accounts.account_id": {
    policy: "refuse",
    kind: "bankSyncLinks",
    sql: "SELECT count(*)::int AS count FROM bank_sync_accounts WHERE user_id = $1 AND account_id = $2",
  },
  "shared_integrations.account_id": {
    policy: "refuse",
    kind: "sharedIntegrations",
    sql: "SELECT count(*)::int AS count FROM shared_integrations WHERE user_id = $1 AND account_id = $2",
  },
  "gem_strategy_accounts.account_id": {
    policy: "refuse",
    kind: "gemStrategies",
    sql: "SELECT count(*)::int AS count FROM gem_strategy_accounts WHERE user_id = $1 AND account_id = $2",
  },
  "accounts.source_account_id": {
    policy: "refuse",
    kind: "linkedAccounts",
    counted: "linkedAccounts",
  },
  "accounts.linked_loan_account_id": {
    policy: "refuse",
    kind: "linkedAccounts",
    counted: "linkedAccounts",
  },
  "accounts.linked_account_id": { policy: "clear" },
  "monthly_account_balances.account_id": { policy: "part" },
  "account_delegate_grants.account_id": { policy: "part" },
  "delegate_account_favourites.account_id": { policy: "part" },
  "delegate_net_worth_exclusions.account_id": { policy: "part" },
  "bank_sync_imported_transactions.account_id": { policy: "part" },
  "loan_scenarios.account_id": { policy: "part" },
  "loan_rate_changes.account_id": { policy: "part" },
  "loan_fees.account_id": { policy: "part" },
} as const satisfies Record<
  string,
  | { policy: "refuse"; kind: AccountReferenceKind; sql: string }
  | {
      policy: "refuse";
      kind: AccountReferenceKind;
      counted: "schedules" | "linkedAccounts";
    }
  | { policy: "part" | "clear" }
>;

const LINKED_ACCOUNTS_SQL =
  "SELECT id FROM accounts WHERE user_id = $1 AND (source_account_id = $2 OR linked_loan_account_id = $2)";

/**
 * Rules, custom reports and investment reports keep an account id inside JSONB with no foreign
 * key, so a delete leaves it dangling. A budget's `config.excludedAccountIds`
 * is not counted: a stale exclusion of a deleted account changes nothing.
 * shortcut: matches the id anywhere in the JSON text; fine for UUIDs.
 */
const JSON_SQL: ReferenceCount[] = [
  {
    kind: "rules",
    sql: "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)",
    like: true,
  },
  {
    kind: "customReports",
    sql: "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND filters::text LIKE $2",
    like: true,
  },
  {
    kind: "investmentReports",
    sql: "SELECT count(*)::int AS count FROM investment_reports WHERE user_id = $1 AND config::text LIKE $2",
    like: true,
  },
  // A UUID[] column, so a real array match rather than LIKE.
  {
    kind: "monteCarloScenarios",
    sql: "SELECT count(*)::int AS count FROM monte_carlo_scenarios WHERE user_id = $1 AND $2::uuid = ANY(account_ids)",
  },
];

/**
 * Every kind of row that still uses the account, with a count above zero. Run
 * inside the delete's transaction, after locking the account row. A `refuse`
 * entry with `sql` is counted by it (a record read: VOID rows count, the delete
 * would destroy them; holdings only while the position is nonzero, ABS() covers
 * rounding residue); `counted` marks the columns counted by
 * `countSchedulesReferencingAccounts` and `LINKED_ACCOUNTS_SQL`. A loan's own
 * payment schedule is left out unless `includeOwnSchedule`: the delete removes
 * it, the undo of a create refuses it.
 */
export function findAccountReferences(
  m: EntityManager,
  userId: string,
  accountId: string,
  options: { includeOwnSchedule?: boolean } = {},
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  accountId = accountId.toLowerCase();
  return countReferences(m, userId, accountId, [
    ...Object.values(ACCOUNT_REFERENCES).flatMap((ref) =>
      ref.policy === "refuse" && "sql" in ref ? [ref] : [],
    ),
    {
      kind: "scheduledTransactions",
      count: async () =>
        (await countSchedulesReferencingAccounts(m, [accountId], options)).get(
          accountId,
        ) ?? 0,
    },
    ...JSON_SQL,
    { kind: "linkedAccounts", sql: LINKED_ACCOUNTS_SQL, ids: true },
  ]);
}
