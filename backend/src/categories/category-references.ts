import { EntityManager } from "typeorm";
import {
  RecordInUseEntry,
  countReferences,
  countReferencesById,
} from "../common/helpers/record-in-use";

/**
 * How deleting a category treats each column with a foreign key to
 * `categories(id)`:
 *  - `refuse`: counted; any row blocks the delete (409 RECORD_IN_USE). The
 *    schema's `ON DELETE SET NULL` would silently uncategorise it.
 *  - `part`: the category's own structure; it goes with the category and is not
 *    counted. Subcategories are handled by the service's earlier 400 and are
 *    reported separately by `findCategoryReferences` because an undo of a
 *    create needs them.
 *  - `clear`: deliberately cleared by the delete; `CategoriesService.remove`
 *    nulls a payee's default category, which is a preference, not data.
 *
 * Keyed `table.column`; `category-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the foreign keys disagree in
 * either direction, so a migration adding a reference names this map.
 */
export const CATEGORY_REFERENCES = {
  "categories.parent_id": { policy: "part" },
  "payees.default_category_id": { policy: "clear" },
  "transactions.category_id": {
    policy: "refuse",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transactions WHERE user_id = $1 AND category_id = $2",
    listSql:
      "SELECT category_id AS id, count(*)::int AS count FROM transactions WHERE user_id = $1 AND category_id IS NOT NULL GROUP BY category_id",
  },
  "transaction_splits.category_id": {
    policy: "refuse",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.user_id = $1 AND s.category_id = $2",
    listSql:
      "SELECT s.category_id AS id, count(*)::int AS count FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.user_id = $1 AND s.category_id IS NOT NULL GROUP BY s.category_id",
  },
  "scheduled_transactions.category_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    sql: "SELECT count(*)::int AS count FROM scheduled_transactions WHERE user_id = $1 AND category_id = $2",
    listSql:
      "SELECT category_id AS id, count(*)::int AS count FROM scheduled_transactions WHERE user_id = $1 AND category_id IS NOT NULL GROUP BY category_id",
  },
  "scheduled_transaction_splits.category_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    sql: "SELECT count(*)::int AS count FROM scheduled_transaction_splits s JOIN scheduled_transactions t ON t.id = s.scheduled_transaction_id WHERE t.user_id = $1 AND s.category_id = $2",
    listSql:
      "SELECT s.category_id AS id, count(*)::int AS count FROM scheduled_transaction_splits s JOIN scheduled_transactions t ON t.id = s.scheduled_transaction_id WHERE t.user_id = $1 AND s.category_id IS NOT NULL GROUP BY s.category_id",
  },
  "scheduled_transaction_overrides.category_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
    sql: "SELECT count(*)::int AS count FROM scheduled_transaction_overrides o JOIN scheduled_transactions t ON t.id = o.scheduled_transaction_id WHERE t.user_id = $1 AND (o.category_id = $2 OR o.splits::text LIKE '%' || $2::text || '%')",
    listSql:
      "SELECT c.id, count(*)::int AS count FROM scheduled_transaction_overrides o JOIN scheduled_transactions t ON t.id = o.scheduled_transaction_id JOIN categories c ON c.user_id = t.user_id AND (o.category_id = c.id OR o.splits::text LIKE '%' || c.id::text || '%') WHERE t.user_id = $1 GROUP BY c.id",
  },
  "budget_categories.category_id": {
    policy: "refuse",
    kind: "budgetLines",
    sql: "SELECT count(*)::int AS count FROM budget_categories c JOIN budgets b ON b.id = c.budget_id WHERE b.user_id = $1 AND c.category_id = $2",
    listSql:
      "SELECT c.category_id AS id, count(*)::int AS count FROM budget_categories c JOIN budgets b ON b.id = c.budget_id WHERE b.user_id = $1 AND c.category_id IS NOT NULL GROUP BY c.category_id",
  },
  "budget_period_categories.category_id": {
    policy: "refuse",
    kind: "budgetPeriods",
    sql: "SELECT count(*)::int AS count FROM budget_period_categories c JOIN budget_periods p ON p.id = c.budget_period_id JOIN budgets b ON b.id = p.budget_id WHERE b.user_id = $1 AND c.category_id = $2",
    listSql:
      "SELECT c.category_id AS id, count(*)::int AS count FROM budget_period_categories c JOIN budget_periods p ON p.id = c.budget_period_id JOIN budgets b ON b.id = p.budget_id WHERE b.user_id = $1 AND c.category_id IS NOT NULL GROUP BY c.category_id",
  },
  "payroll_deduction_rules.category_id": {
    policy: "refuse",
    kind: "payrollDeductionRules",
    sql: "SELECT count(*)::int AS count FROM payroll_deduction_rules WHERE user_id = $1 AND category_id = $2",
    listSql:
      "SELECT category_id AS id, count(*)::int AS count FROM payroll_deduction_rules WHERE user_id = $1 AND category_id IS NOT NULL GROUP BY category_id",
  },
  "loan_fees.category_id": {
    policy: "refuse",
    kind: "loanFees",
    sql: "SELECT count(*)::int AS count FROM loan_fees WHERE user_id = $1 AND category_id = $2",
    listSql:
      "SELECT category_id AS id, count(*)::int AS count FROM loan_fees WHERE user_id = $1 AND category_id IS NOT NULL GROUP BY category_id",
  },
  "shared_postings.category_id": {
    policy: "refuse",
    kind: "sharedPostings",
    sql: "SELECT count(*)::int AS count FROM shared_postings WHERE user_id = $1 AND category_id = $2",
    listSql:
      "SELECT category_id AS id, count(*)::int AS count FROM shared_postings WHERE user_id = $1 AND category_id IS NOT NULL GROUP BY category_id",
  },
  "accounts.principal_category_id": {
    policy: "refuse",
    kind: "loanAccounts",
    counted: "loanAccounts",
  },
  "accounts.interest_category_id": {
    policy: "refuse",
    kind: "loanAccounts",
    counted: "loanAccounts",
  },
  "accounts.overpayment_category_id": {
    policy: "refuse",
    kind: "loanAccounts",
    counted: "loanAccounts",
  },
  "accounts.asset_category_id": {
    policy: "refuse",
    kind: "loanAccounts",
    counted: "loanAccounts",
  },
} as const satisfies Record<
  string,
  | {
      policy: "refuse";
      kind: CategoryReferenceKind;
      sql: string;
      listSql: string;
    }
  | { policy: "refuse"; kind: "loanAccounts"; counted: "loanAccounts" }
  | { policy: "part" | "clear" }
>;

/** What blocks deleting a category: one entry per kind of row still using it. */
export type CategoryReferenceKind =
  | "transactions"
  | "scheduledTransactions"
  | "budgetLines"
  | "budgetPeriods"
  | "payrollDeductionRules"
  | "loanFees"
  | "loanAccounts"
  | "sharedPostings"
  | "rules"
  | "customReports"
  | "subcategories";

/** The four loan columns report account ids so the client can link to them. */
const LOAN_ACCOUNTS_SQL =
  "SELECT id FROM accounts WHERE user_id = $1 AND (principal_category_id = $2 OR interest_category_id = $2 OR overpayment_category_id = $2 OR asset_category_id = $2)";

/**
 * Rules and custom reports keep a category id inside JSONB with no foreign key,
 * so a delete leaves it dangling. shortcut: matches the id anywhere in the JSON
 * text; fine for UUIDs.
 */
const RULES_SQL =
  "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)";
const REPORTS_SQL =
  "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND filters::text LIKE $2";
const CHILDREN_SQL =
  "SELECT count(*)::int AS count FROM categories WHERE user_id = $1 AND parent_id = $2";

/**
 * Every kind of row that still uses the category, with a count above zero. Run
 * inside the delete's transaction, after locking the category row. A `refuse`
 * entry with `sql` is counted by it; `counted: "loanAccounts"` marks the four
 * loan columns that `LOAN_ACCOUNTS_SQL` counts once, with ids.
 */
export function findCategoryReferences(
  m: EntityManager,
  userId: string,
  categoryId: string,
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  return countReferences(m, userId, categoryId.toLowerCase(), [
    ...Object.values(CATEGORY_REFERENCES).flatMap((ref) =>
      ref.policy === "refuse" && "sql" in ref ? [ref] : [],
    ),
    { kind: "rules", sql: RULES_SQL, like: true },
    { kind: "customReports", sql: REPORTS_SQL, like: true },
    { kind: "subcategories", sql: CHILDREN_SQL },
    { kind: "loanAccounts", sql: LOAN_ACCOUNTS_SQL, ids: true },
  ]);
}

/** The loan columns, grouped; an account naming the category twice counts once. */
const LOAN_ACCOUNTS_LIST_SQL =
  "SELECT c.id, count(*)::int AS count FROM accounts a JOIN categories c ON c.user_id = a.user_id AND c.id IN (a.principal_category_id, a.interest_category_id, a.overpayment_category_id, a.asset_category_id) WHERE a.user_id = $1 GROUP BY c.id";
const RULES_LIST_SQL =
  "SELECT c.id, count(*)::int AS count FROM transaction_rules r JOIN categories c ON c.user_id = r.user_id AND (r.condition::text LIKE '%' || c.id::text || '%' OR r.actions::text LIKE '%' || c.id::text || '%') WHERE r.user_id = $1 GROUP BY c.id";
const REPORTS_LIST_SQL =
  "SELECT c.id, count(*)::int AS count FROM custom_reports r JOIN categories c ON c.user_id = r.user_id AND r.filters::text LIKE '%' || c.id::text || '%' WHERE r.user_id = $1 GROUP BY c.id";

/**
 * How many rows use each of the user's categories, by the same references
 * `findCategoryReferences` refuses a delete for (subcategories aside, which the
 * service refuses on their own), so the list's count and the 409 agree.
 */
export function countCategoryUsage(
  m: EntityManager,
  userId: string,
): Promise<Map<string, number>> {
  return countReferencesById(m, userId, [
    ...Object.values(CATEGORY_REFERENCES).flatMap((ref) =>
      ref.policy === "refuse" && "listSql" in ref ? [ref.listSql] : [],
    ),
    LOAN_ACCOUNTS_LIST_SQL,
    RULES_LIST_SQL,
    REPORTS_LIST_SQL,
  ]);
}
