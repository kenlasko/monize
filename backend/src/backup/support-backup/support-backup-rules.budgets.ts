import {
  TableRules,
  drop,
  keep,
  mask,
  scale,
} from "./support-backup-rule-kinds";

/**
 * The budget tables' de-identification rules: budgets, their lines, buckets
 * and periods, and the per-period line and bucket snapshots.
 *
 * Split out of `support-backup-rules.ts` when the bucket tables
 * (docs/future-plans/bucket-budget.md sections 6.1 to 6.3) would have pushed
 * that file past the repository's 800-line ceiling. Merged back into the one
 * `RULES` map where the budget block stood, so the golden test still reads a
 * single registry and a column with no rule is still dropped.
 */
export const BUDGET_RULES: Record<string, TableRules> = {
  budgets: {
    id: keep,
    user_id: keep,
    name: mask,
    description: drop,
    budget_type: keep,
    period_start: keep,
    period_end: keep,
    base_income: scale,
    income_linked: keep,
    strategy: keep,
    is_active: keep,
    currency_code: keep,
    config: keep, // inventoried: flags/percentages/UUIDs only, no amounts
    created_at: keep,
    updated_at: keep,
  },
  budget_buckets: {
    id: keep,
    budget_id: keep,
    name: mask, // user-authored bucket name
    target_type: keep,
    // An amount when target_type is AMOUNT, so scaled: a rule is per column,
    // and an unscaled amount would disclose the real figure. A PERCENT target
    // is scaled with it, as budget_categories.amount is for a percentage line.
    target_value: scale,
    carry_over: keep,
    carry_cap: scale,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
  budget_categories: {
    id: keep,
    budget_id: keep,
    category_id: keep,
    transfer_account_id: keep,
    is_transfer: keep,
    category_group: keep,
    amount: scale,
    // income-flag-ok: column classification of the budget line's own column
    is_income: keep,
    rollover_type: keep,
    rollover_cap: scale,
    flex_group: mask, // user-authored group name
    alert_warn_percent: keep,
    alert_critical_percent: keep,
    notes: drop,
    sort_order: keep,
    bucket_id: keep,
    created_at: keep,
    updated_at: keep,
  },
  budget_periods: {
    id: keep,
    budget_id: keep,
    period_start: keep,
    period_end: keep,
    actual_income: scale,
    actual_expenses: scale,
    total_budgeted: scale,
    status: keep,
    created_at: keep,
    updated_at: keep,
  },
  budget_period_categories: {
    id: keep,
    budget_period_id: keep,
    budget_category_id: keep,
    category_id: keep,
    budgeted_amount: scale,
    rollover_in: scale,
    actual_amount: scale,
    effective_budget: scale,
    rollover_out: scale,
    created_at: keep,
    updated_at: keep,
  },
  budget_period_buckets: {
    id: keep,
    budget_period_id: keep,
    bucket_id: keep,
    // The bucket's name as it was; masked the same way as budget_buckets.name.
    bucket_name: mask,
    target_type: keep,
    target_value: scale,
    income_basis: scale,
    allocated_amount: scale,
    carry_in: scale,
    actual_amount: scale,
    carry_out: scale,
    created_at: keep,
    updated_at: keep,
  },
};
