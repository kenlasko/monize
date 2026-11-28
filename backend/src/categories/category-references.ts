import { EntityManager } from "typeorm";
import {
  CountedReference,
  RecordInUseEntry,
  REPORTS_JSON,
  RULES_JSON,
  countReferences,
  countReferencesById,
  jsonIdListSql,
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
    sql: "SELECT count(*)::int AS count FROM scheduled_transaction_overrides o JOIN scheduled_transactions t ON t.id = o.scheduled_transaction_id WHERE t.user_id = $1 AND (o.category_id = $2 OR lower(o.splits::text) LIKE '%' || lower($2::text) || '%')",
    listSql: jsonIdListSql({
      from: "scheduled_transaction_overrides o JOIN scheduled_transactions st ON st.id = o.scheduled_transaction_id",
      rowId: "o.id",
      userColumn: "st.user_id",
      text: "coalesce(o.category_id::text, '') || ' ' || coalesce(o.splits::text, '')",
      target: "categories",
    }),
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

const CHILDREN_SQL =
  "SELECT count(*)::int AS count FROM categories WHERE user_id = $1 AND parent_id = $2";

/**
 * The kinds the foreign-key map cannot hold, each with its per-record and its
 * list count. The four loan columns report account ids so the client can link
 * to them. Rules and custom reports keep a category id inside JSONB with no
 * foreign key, so a delete leaves it dangling. shortcut: the guard matches the
 * id anywhere in the JSON text; fine for UUIDs.
 */
const CATEGORY_OTHER_REFERENCES: readonly CountedReference[] = [
  {
    kind: "loanAccounts",
    ids: true,
    sql: "SELECT id FROM accounts WHERE user_id = $1 AND (principal_category_id = $2 OR interest_category_id = $2 OR overpayment_category_id = $2 OR asset_category_id = $2)",
    // An account naming the category twice counts once.
    listSql:
      "SELECT c.id, count(*)::int AS count FROM accounts a JOIN categories c ON c.user_id = a.user_id AND c.id IN (a.principal_category_id, a.interest_category_id, a.overpayment_category_id, a.asset_category_id) WHERE a.user_id = $1 GROUP BY c.id",
  },
  {
    kind: "rules",
    like: true,
    sql: "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (lower(condition::text) LIKE $2 OR lower(actions::text) LIKE $2)",
    listSql: jsonIdListSql({ ...RULES_JSON, target: "categories" }),
  },
  {
    kind: "customReports",
    like: true,
    sql: "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND lower(filters::text) LIKE $2",
    listSql: jsonIdListSql({ ...REPORTS_JSON, target: "categories" }),
  },
];

/** The foreign-key map's `refuse` entries that carry their own SQL. */
const mappedReferences = () =>
  Object.values(CATEGORY_REFERENCES).flatMap((ref) =>
    ref.policy === "refuse" && "sql" in ref ? [ref] : [],
  );

/**
 * Every kind of row that still uses the category, with a count above zero. Run
 * inside the delete's transaction, after locking the category row. A `refuse`
 * entry with `sql` is counted by it; `counted: "loanAccounts"` marks the four
 * loan columns that the `loanAccounts` entry counts once, with ids.
 */
export function findCategoryReferences(
  m: EntityManager,
  userId: string,
  categoryId: string,
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  return countReferences(m, userId, categoryId.toLowerCase(), [
    ...mappedReferences(),
    ...CATEGORY_OTHER_REFERENCES,
    { kind: "subcategories", sql: CHILDREN_SQL },
  ]);
}

/**
 * How many rows use each of the user's categories, by the same references
 * `findCategoryReferences` refuses a delete for (subcategories aside, which the
 * service refuses on their own), so the list's count and the 409 agree.
 */
export function countCategoryUsage(
  m: EntityManager,
  userId: string,
): Promise<Map<string, number>> {
  return countReferencesById(
    m,
    userId,
    [...mappedReferences(), ...CATEGORY_OTHER_REFERENCES].map((r) => r.listSql),
  );
}
