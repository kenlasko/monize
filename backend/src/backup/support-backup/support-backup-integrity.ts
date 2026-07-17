import { TableMap } from "./support-backup-scope";

/**
 * Referential-integrity scrub for trimmed exports. Account scoping and date
 * ranges remove rows; any foreign key still pointing at a removed row would
 * make the file unrestorable (the restore inserts most FKs inline and
 * re-applies the deferred ones with an unconditional UPDATE). Instead of
 * patching individual columns per feature, this pass walks a declarative map
 * of every FK between exported tables and repairs each dangling reference:
 *
 * - `null`: clear the column (nullable FKs -- lost cross-link, row survives),
 * - `dropRow`: remove the row (NOT NULL FKs, junction rows, or rows that are
 *   meaningless without their target, e.g. a transfer split whose target
 *   account is gone -- keeping it with a null would violate a CHECK
 *   constraint).
 *
 * The map lists physical FKs from database/schema.sql between tables that the
 * support backup exports. FKs to `users` and `currencies` are excluded: users
 * is never exported (restore rescopes user_id) and currencies are restored by
 * code, not by id.
 */
interface RefRule {
  column: string;
  refTable: string;
  onMissing: "null" | "dropRow";
}

const REFS: Record<string, RefRule[]> = {
  categories: [
    { column: "parent_id", refTable: "categories", onMissing: "null" },
  ],
  payees: [
    {
      column: "default_category_id",
      refTable: "categories",
      onMissing: "null",
    },
  ],
  payee_aliases: [
    { column: "payee_id", refTable: "payees", onMissing: "dropRow" },
  ],
  accounts: [
    { column: "linked_account_id", refTable: "accounts", onMissing: "null" },
    {
      column: "linked_loan_account_id",
      refTable: "accounts",
      onMissing: "null",
    },
    { column: "source_account_id", refTable: "accounts", onMissing: "null" },
    { column: "institution_id", refTable: "institutions", onMissing: "null" },
    {
      column: "principal_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    {
      column: "interest_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    { column: "asset_category_id", refTable: "categories", onMissing: "null" },
    {
      column: "overpayment_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    { column: "overpayment_payee_id", refTable: "payees", onMissing: "null" },
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "null",
    },
  ],
  transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "payee_id", refTable: "payees", onMissing: "null" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    {
      column: "parent_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
    {
      column: "linked_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
  ],
  transaction_splits: [
    {
      column: "transaction_id",
      refTable: "transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    // A transfer split without its target violates chk_split_kind_exclusive,
    // so the row goes rather than the column.
    {
      column: "transfer_account_id",
      refTable: "accounts",
      onMissing: "dropRow",
    },
    {
      column: "linked_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
  ],
  transaction_tags: [
    {
      column: "transaction_id",
      refTable: "transactions",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  transaction_split_tags: [
    {
      column: "transaction_split_id",
      refTable: "transaction_splits",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  scheduled_transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "payee_id", refTable: "payees", onMissing: "null" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    { column: "transfer_account_id", refTable: "accounts", onMissing: "null" },
    {
      column: "investment_security_id",
      refTable: "securities",
      onMissing: "null",
    },
    {
      column: "investment_funding_account_id",
      refTable: "accounts",
      onMissing: "null",
    },
  ],
  scheduled_transaction_splits: [
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    {
      column: "transfer_account_id",
      refTable: "accounts",
      onMissing: "dropRow",
    },
    {
      column: "investment_security_id",
      refTable: "securities",
      onMissing: "null",
    },
  ],
  scheduled_transaction_overrides: [
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
  ],
  scheduled_transaction_split_tags: [
    {
      column: "scheduled_transaction_split_id",
      refTable: "scheduled_transaction_splits",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  security_prices: [
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
  ],
  security_tags: [
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  holdings: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
  ],
  investment_transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "transaction_id", refTable: "transactions", onMissing: "null" },
    {
      column: "transaction_split_id",
      refTable: "transaction_splits",
      onMissing: "null",
    },
    {
      column: "linked_transaction_id",
      refTable: "investment_transactions",
      onMissing: "null",
    },
    { column: "security_id", refTable: "securities", onMissing: "null" },
    { column: "funding_account_id", refTable: "accounts", onMissing: "null" },
  ],
  loan_rate_changes: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  loan_scenarios: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  budget_categories: [
    { column: "budget_id", refTable: "budgets", onMissing: "dropRow" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    { column: "transfer_account_id", refTable: "accounts", onMissing: "null" },
  ],
  budget_periods: [
    { column: "budget_id", refTable: "budgets", onMissing: "dropRow" },
  ],
  budget_period_categories: [
    {
      column: "budget_period_id",
      refTable: "budget_periods",
      onMissing: "dropRow",
    },
    {
      column: "budget_category_id",
      refTable: "budget_categories",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
  ],
  budget_alerts: [
    { column: "budget_id", refTable: "budgets", onMissing: "null" },
    {
      column: "budget_category_id",
      refTable: "budget_categories",
      onMissing: "null",
    },
  ],
  monthly_account_balances: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  monte_carlo_cash_flows: [
    {
      column: "scenario_id",
      refTable: "monte_carlo_scenarios",
      onMissing: "dropRow",
    },
  ],
};

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Repairs every dangling reference in the (possibly trimmed) table map.
 * Iterates to a fixed point because dropping a row can orphan its own
 * dependents (e.g. dropping a transfer split orphans its split-tag rows);
 * the dependency graph is shallow, so this converges in a few passes.
 *
 * Also scopes the id arrays that live outside FK constraints:
 * `monte_carlo_scenarios.account_ids` is filtered to accounts present in the
 * file (a plain UUID[] with no FK -- stale entries would leak the user's real
 * account ids un-remapped), and `custom_reports.filters` id arrays are
 * filtered for the same reason (the JSONB rule keeps them otherwise).
 */
export function scrubDanglingRefs(tables: TableMap): TableMap {
  const out: TableMap = { ...tables };

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;

    const presentIds = new Map<string, Set<string>>();
    const idsOf = (table: string): Set<string> => {
      let ids = presentIds.get(table);
      if (!ids) {
        ids = new Set(
          (out[table] ?? [])
            .map((row) => str(row.id))
            .filter((id): id is string => id !== null),
        );
        presentIds.set(table, ids);
      }
      return ids;
    };

    for (const [table, rules] of Object.entries(REFS)) {
      const rows = out[table];
      if (!rows || rows.length === 0) continue;

      const next: Record<string, unknown>[] = [];
      for (const row of rows) {
        let kept: Record<string, unknown> | null = row;
        for (const rule of rules) {
          const ref = str(row[rule.column]);
          if (ref === null || idsOf(rule.refTable).has(ref)) continue;
          if (rule.onMissing === "dropRow") {
            kept = null;
            break;
          }
          kept = kept === row ? { ...row } : kept;
          kept[rule.column] = null;
        }
        if (kept !== null) {
          next.push(kept);
          if (kept !== row) changed = true;
        } else {
          changed = true;
        }
      }
      if (next.length !== rows.length || changed) out[table] = next;
    }

    if (!changed) break;
    presentIds.clear();
  }

  const accountIds = new Set(
    (out.accounts ?? []).map((a) => str(a.id)).filter(Boolean),
  );
  out.monte_carlo_scenarios = (out.monte_carlo_scenarios ?? []).map((s) =>
    Array.isArray(s.account_ids)
      ? {
          ...s,
          account_ids: s.account_ids.filter((id) => accountIds.has(str(id))),
        }
      : s,
  );
  out.custom_reports = (out.custom_reports ?? []).map((report) => {
    const filters = report.filters;
    if (typeof filters !== "object" || filters === null) return report;
    const scoped = { ...(filters as Record<string, unknown>) };
    if (Array.isArray(scoped.accountIds)) {
      scoped.accountIds = scoped.accountIds.filter((id) =>
        accountIds.has(str(id)),
      );
    }
    return { ...report, filters: scoped };
  });

  return out;
}
