import { keep, konst, scale } from "./support-backup-rule-kinds";
import type { TableRules } from "./support-backup-rule-kinds";

/** Timing structure is diagnostic; source hashes must not re-identify amounts. */
export const ACCRUAL_RULES: Record<string, TableRules> = {
  accrual_system_accounts: {
    id: keep,
    user_id: keep,
    family: keep,
    currency_code: keep,
    created_at: keep,
  },
  accrual_schedules: {
    id: keep,
    user_id: keep,
    source_transaction_id: keep,
    source_split_id: keep,
    family: keep,
    currency_code: keep,
    preset: keep,
    recognition_date_rule: keep,
    start_month: keep,
    month_count: keep,
    revision: keep,
    source_fingerprint: konst("0".repeat(64)),
    created_at: keep,
    updated_at: keep,
  },
  accrual_allocations: {
    id: keep,
    user_id: keep,
    schedule_id: keep,
    period_index: keep,
    recognition_date: keep,
    amount: scale,
  },
};
