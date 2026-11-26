import { EntityManager } from "typeorm";
import { RecordInUseEntry } from "../common/helpers/record-in-use";
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
  | "budgets";

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
  "transactions.account_id": { policy: "refuse", kind: "transactions" },
  "transaction_splits.transfer_account_id": {
    policy: "refuse",
    kind: "transactions",
  },
  "investment_transactions.account_id": {
    policy: "refuse",
    kind: "investmentTransactions",
  },
  "investment_transactions.funding_account_id": {
    policy: "refuse",
    kind: "investmentTransactions",
  },
  "holdings.account_id": { policy: "refuse", kind: "holdings" },
  "scheduled_transactions.account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "scheduled_transactions.transfer_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "scheduled_transactions.investment_funding_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "scheduled_transaction_splits.transfer_account_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "budget_categories.transfer_account_id": {
    policy: "refuse",
    kind: "budgetLines",
  },
  "bank_sync_accounts.account_id": { policy: "refuse", kind: "bankSyncLinks" },
  "shared_integrations.account_id": {
    policy: "refuse",
    kind: "sharedIntegrations",
  },
  "gem_strategy_accounts.account_id": {
    policy: "refuse",
    kind: "gemStrategies",
  },
  "accounts.source_account_id": { policy: "refuse", kind: "linkedAccounts" },
  "accounts.linked_loan_account_id": {
    policy: "refuse",
    kind: "linkedAccounts",
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
  | { policy: "refuse"; kind: AccountReferenceKind }
  | { policy: "part" | "clear" }
>;

/**
 * Counting SQL per `refuse` column except the schedules and linked accounts,
 * which have their own queries; `$1` is the user, `$2` the account.
 * A record read: includes VOID rows, a VOID row is still a row the delete
 * would destroy.
 */
const COUNT_SQL: Record<string, string> = {
  "transactions.account_id":
    "SELECT count(*)::int AS count FROM transactions WHERE user_id = $1 AND account_id = $2",
  "transaction_splits.transfer_account_id":
    "SELECT count(*)::int AS count FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.user_id = $1 AND s.transfer_account_id = $2",
  "investment_transactions.account_id":
    "SELECT count(*)::int AS count FROM investment_transactions WHERE user_id = $1 AND account_id = $2",
  "investment_transactions.funding_account_id":
    "SELECT count(*)::int AS count FROM investment_transactions WHERE user_id = $1 AND funding_account_id = $2",
  // Only a nonzero position; ABS() covers a small residue left by rounding.
  "holdings.account_id":
    "SELECT count(*)::int AS count FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE a.user_id = $1 AND h.account_id = $2 AND ABS(h.quantity) > 0.00000001",
  "budget_categories.transfer_account_id":
    "SELECT count(*)::int AS count FROM budget_categories c JOIN budgets b ON b.id = c.budget_id WHERE b.user_id = $1 AND c.transfer_account_id = $2",
  "bank_sync_accounts.account_id":
    "SELECT count(*)::int AS count FROM bank_sync_accounts WHERE user_id = $1 AND account_id = $2",
  "shared_integrations.account_id":
    "SELECT count(*)::int AS count FROM shared_integrations WHERE user_id = $1 AND account_id = $2",
  "gem_strategy_accounts.account_id":
    "SELECT count(*)::int AS count FROM gem_strategy_accounts WHERE user_id = $1 AND account_id = $2",
};

const LINKED_ACCOUNTS_SQL =
  "SELECT id FROM accounts WHERE user_id = $1 AND (source_account_id = $2 OR linked_loan_account_id = $2)";

/**
 * Rules, custom reports and budgets keep an account id inside JSONB with no
 * foreign key, so a delete leaves it dangling. shortcut: matches the id
 * anywhere in the JSON text; fine for UUIDs.
 */
const JSON_SQL: [AccountReferenceKind, string][] = [
  [
    "rules",
    "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)",
  ],
  [
    "customReports",
    "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND filters::text LIKE $2",
  ],
  [
    "budgets",
    "SELECT count(*)::int AS count FROM budgets WHERE user_id = $1 AND config::text LIKE $2",
  ],
];

/**
 * Every kind of row that still uses the account, with a count above zero. Run
 * inside the delete's transaction, after locking the account row. A loan's own
 * payment schedule is left out unless `includeOwnSchedule`: the delete removes
 * it, the undo of a create refuses it.
 */
export async function findAccountReferences(
  m: EntityManager,
  userId: string,
  accountId: string,
  options: { includeOwnSchedule?: boolean } = {},
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  accountId = accountId.toLowerCase();
  const counts = new Map<AccountReferenceKind, number>();
  const add = (kind: AccountReferenceKind, n: number) =>
    counts.set(kind, (counts.get(kind) ?? 0) + n);
  const count = async (sql: string, ...params: string[]) => {
    const rows: { count?: number }[] = await m.query(sql, params);
    return Number(rows[0]?.count) || 0;
  };

  for (const [column, ref] of Object.entries(ACCOUNT_REFERENCES)) {
    if (ref.policy === "refuse" && COUNT_SQL[column]) {
      add(ref.kind, await count(COUNT_SQL[column], userId, accountId));
    }
  }
  add(
    "scheduledTransactions",
    (await countSchedulesReferencingAccounts(m, [accountId], options)).get(
      accountId,
    ) ?? 0,
  );
  const linked: { id: string }[] = await m.query(LINKED_ACCOUNTS_SQL, [
    userId,
    accountId,
  ]);
  for (const [kind, sql] of JSON_SQL) {
    add(kind, await count(sql, userId, `%${accountId}%`));
  }

  const found: RecordInUseEntry[] = [];
  for (const [kind, n] of counts) {
    if (n > 0) found.push({ kind, count: n });
  }
  if (linked.length > 0) {
    found.push({
      kind: "linkedAccounts",
      count: linked.length,
      ids: linked.map((r) => r.id),
    });
  }
  return found;
}
