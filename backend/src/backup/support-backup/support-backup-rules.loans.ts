import {
  TableRules,
  drop,
  jsonb,
  keep,
  mask,
  scale,
} from "./support-backup-rule-kinds";

/**
 * The loan tables' de-identification rules: rate history, mortgage fees
 * (`docs/specs/mortgage-fees.md`) and saved overpayment scenarios.
 *
 * In their own file because the mortgage fee table pushed
 * `support-backup-rules.ts` past the repository's 800-line ceiling, as the
 * warranty and planning tables did before it. Merged back into the one `RULES`
 * map, so the golden test still reads a single registry and a column with no
 * rule is still dropped.
 */
export const LOAN_RULES: Record<string, TableRules> = {
  loan_rate_changes: {
    id: keep,
    user_id: keep,
    account_id: keep,
    effective_date: keep,
    annual_rate: keep, // public rate
    new_payment_amount: scale,
    source: keep,
    note: drop,
    created_at: keep,
    updated_at: keep,
  },
  loan_fees: {
    id: keep,
    user_id: keep,
    account_id: keep,
    category_id: keep,
    name: mask,
    calculation: keep,
    basis: keep,
    amount: scale,
    rate: keep,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
  loan_scenarios: {
    id: keep,
    user_id: keep,
    account_id: keep,
    name: mask,
    recurring_extra_amount: scale,
    recurring_extra_mode: keep,
    recurring_extra_frequency: keep,
    recurring_extra_start_date: keep,
    recurring_extra_end_date: keep,
    target_monthly_payment: scale,
    target_monthly_payment_mode: keep,
    target_monthly_payment_start_date: keep,
    target_monthly_payment_end_date: keep,
    lump_sums: jsonb("lumpSums"),
    created_at: keep,
    updated_at: keep,
  },
};
