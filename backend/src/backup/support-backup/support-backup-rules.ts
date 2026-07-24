import { JsonbHandlerName } from "./support-backup-jsonb";

/**
 * Per-column de-identification rules for the support backup. This registry is
 * the single source of truth for what happens to every exported column, and it
 * is an ALLOWLIST: a column with no rule is dropped from the output, and the
 * golden test (support-backup-coverage) fails when the live schema gains a
 * column this registry does not classify -- so a future migration cannot
 * silently start leaking a new field.
 */
export type ColumnRule =
  | { t: "keep" } // structure, dates, enums, flags, FKs, public reference values
  | { t: "mask" } // free text / names: keep first+last 2 chars, star the middle
  | { t: "drop" } // set to null (highest-risk free text, secrets, bulk blobs)
  | { t: "const"; value: unknown } // fixed replacement for NOT NULL dropped fields
  | { t: "scale" } // private money magnitude x M (4 dp)
  | { t: "scaleQty" } // private quantity x M (8 dp)
  | { t: "jsonb"; handler: JsonbHandlerName }; // per-key handler for a JSON blob

const keep: ColumnRule = { t: "keep" };
const mask: ColumnRule = { t: "mask" };
const drop: ColumnRule = { t: "drop" };
const scale: ColumnRule = { t: "scale" };
const scaleQty: ColumnRule = { t: "scaleQty" };
const konst = (value: unknown): ColumnRule => ({ t: "const", value });
const jsonb = (handler: JsonbHandlerName): ColumnRule => ({
  t: "jsonb",
  handler,
});

export type TableRules = Record<string, ColumnRule>;

/**
 * Tables never written to a support backup regardless of section selection.
 * `ai_provider_configs` holds encrypted API keys and endpoint URLs with zero
 * diagnostic value for a finance bug, so it is dropped wholesale (its columns
 * are intentionally absent from RULES below; the golden test skips it).
 */
export const ALWAYS_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "ai_provider_configs",
]);

export const RULES: Record<string, TableRules> = {
  currencies: {
    code: keep,
    name: keep,
    symbol: keep,
    decimal_places: keep,
    is_active: keep,
    created_by_user_id: keep,
    created_at: keep,
  },
  user_preferences: {
    user_id: keep,
    default_currency: keep,
    date_format: keep,
    number_format: keep,
    theme: keep,
    color_theme: keep,
    timezone: konst("UTC"),
    notification_email: keep,
    notification_browser: keep,
    two_factor_enabled: keep,
    getting_started_dismissed: keep,
    week_starts_on: keep,
    budget_digest_enabled: keep,
    budget_digest_day: keep,
    favourite_report_ids: keep,
    dashboard_widgets: keep,
    dashboard_widget_config: keep,
    show_created_at: keep,
    time_format: keep,
    preferred_exchanges: keep,
    dismissed_update_version: keep,
    last_seen_version: keep,
    show_whats_new: keep,
    tour_progress: keep, // guided-tour completion state; opaque ids + status, no PII
    default_quote_provider: keep,
    recent_transactions_limit: keep,
    ai_bubble_enabled: keep,
    language: keep,
    last_client_timezone: drop, // location hint
    created_at: keep,
    updated_at: keep,
  },
  user_currency_preferences: {
    user_id: keep,
    currency_code: keep,
    is_active: keep,
    created_at: keep,
  },
  categories: {
    id: keep,
    user_id: keep,
    parent_id: keep,
    name: mask,
    description: drop,
    icon: keep,
    color: keep,
    is_income: keep,
    is_system: keep,
    created_at: keep,
  },
  payees: {
    id: keep,
    user_id: keep,
    name: mask,
    default_category_id: keep,
    notes: drop,
    is_active: keep,
    created_at: keep,
  },
  payee_aliases: {
    id: keep,
    payee_id: keep,
    user_id: keep,
    alias: mask,
    created_at: keep,
  },
  institutions: {
    id: keep,
    user_id: keep,
    name: mask,
    website: konst(""), // NOT NULL
    country: keep,
    logo_data: drop,
    logo_content_type: drop,
    has_logo: konst(false),
    logo_fetched_at: drop,
    created_at: keep,
    updated_at: keep,
  },
  accounts: {
    id: keep,
    user_id: keep,
    account_type: keep,
    account_sub_type: keep,
    linked_account_id: keep,
    name: mask,
    description: drop,
    currency_code: keep,
    account_number: drop,
    institution: mask, // legacy free-text institution name
    institution_id: keep,
    opening_balance: scale,
    current_balance: scale, // refined by reconciliation
    credit_limit: scale,
    interest_rate: keep, // public rate
    fx_fee_percent: keep, // public foreign-transaction fee rate
    statement_due_day: keep,
    statement_settlement_day: keep,
    is_closed: keep,
    closed_date: keep,
    is_favourite: keep,
    favourite_sort_order: keep,
    exclude_from_net_worth: keep,
    payment_amount: scale,
    payment_frequency: keep,
    payment_start_date: keep,
    source_account_id: keep,
    principal_category_id: keep,
    interest_category_id: keep,
    interest_booking_mode: keep,
    overpayment_category_id: keep,
    overpayment_memo: drop,
    overpayment_payee_id: keep,
    scheduled_transaction_id: keep,
    asset_category_id: keep,
    date_acquired: keep,
    linked_loan_account_id: keep,
    is_canadian_mortgage: keep,
    is_variable_rate: keep,
    term_months: keep,
    term_end_date: keep,
    amortization_months: keep,
    original_principal: scale,
    created_at: keep,
    updated_at: keep,
  },
  tags: {
    id: keep,
    user_id: keep,
    name: mask,
    color: keep,
    icon: keep,
    created_at: keep,
    updated_at: keep,
  },
  transactions: {
    id: keep,
    user_id: keep,
    account_id: keep,
    transaction_date: keep,
    payee_id: keep,
    payee_name: mask,
    category_id: keep,
    amount: scale, // split parents refined by reconciliation
    currency_code: keep,
    original_amount: scale, // private money magnitude, in foreign currency
    original_currency_code: keep, // public reference value
    exchange_rate: keep, // public FX rate
    description: drop,
    reference_number: drop,
    is_cleared: keep,
    is_reconciled: keep,
    reconciled_date: keep,
    status: keep,
    is_split: keep,
    parent_transaction_id: keep,
    is_transfer: keep,
    linked_transaction_id: keep,
    created_at: keep,
    updated_at: keep,
  },
  transaction_splits: {
    id: keep,
    transaction_id: keep,
    kind: keep,
    category_id: keep,
    transfer_account_id: keep,
    linked_transaction_id: keep,
    amount: scale,
    memo: drop,
    created_at: keep,
  },
  transaction_tags: { transaction_id: keep, tag_id: keep },
  transaction_split_tags: { transaction_split_id: keep, tag_id: keep },
  scheduled_transactions: {
    id: keep,
    user_id: keep,
    account_id: keep,
    name: mask,
    payee_id: keep,
    payee_name: mask,
    category_id: keep,
    amount: scale,
    currency_code: keep,
    description: drop,
    frequency: keep,
    next_due_date: keep,
    start_date: keep,
    end_date: keep,
    occurrences_remaining: keep,
    total_occurrences: keep,
    is_active: keep,
    auto_post: keep,
    reminder_days_before: keep,
    last_posted_date: keep,
    is_split: keep,
    is_transfer: keep,
    transfer_account_id: keep,
    is_investment: keep,
    investment_action: keep,
    investment_security_id: keep,
    investment_funding_account_id: keep,
    investment_quantity: scaleQty,
    investment_price: keep, // public per-unit price
    investment_commission: scale,
    investment_total_amount: scale,
    investment_exchange_rate: keep,
    tag_ids: keep, // UUID array, covered by id remap
    created_at: keep,
    updated_at: keep,
  },
  scheduled_transaction_splits: {
    id: keep,
    scheduled_transaction_id: keep,
    kind: keep,
    category_id: keep,
    transfer_account_id: keep,
    amount: scale,
    memo: drop,
    investment_action: keep,
    investment_security_id: keep,
    investment_quantity: scaleQty,
    investment_price: keep,
    investment_commission: scale,
    investment_exchange_rate: keep,
    created_at: keep,
  },
  scheduled_transaction_overrides: {
    id: keep,
    scheduled_transaction_id: keep,
    original_date: keep,
    override_date: keep,
    amount: scale,
    category_id: keep,
    description: drop,
    is_split: keep,
    splits: jsonb("overrideSplits"),
    investment_quantity: scaleQty,
    investment_price: keep,
    investment_total_amount: scale,
    created_at: keep,
    updated_at: keep,
  },
  scheduled_transaction_split_tags: {
    scheduled_transaction_split_id: keep,
    tag_id: keep,
  },
  securities: {
    id: keep,
    user_id: keep,
    symbol: mask,
    name: mask,
    security_type: keep,
    exchange: keep,
    currency_code: keep,
    description: drop,
    is_active: keep,
    is_favourite: keep,
    skip_price_updates: keep,
    sector: keep,
    industry: keep,
    sector_weightings: keep, // public weightings
    country_weightings: keep,
    sector_data_updated_at: keep,
    quote_provider: keep,
    msn_instrument_id: drop, // would identify a masked ticker
    historical_backfill_attempted_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  security_prices: {
    id: keep,
    security_id: keep,
    price_date: keep,
    open_price: keep,
    high_price: keep,
    low_price: keep,
    close_price: keep,
    adjusted_close: keep,
    volume: keep,
    source: keep,
    created_at: keep,
  },
  holdings: {
    id: keep,
    account_id: keep,
    security_id: keep,
    quantity: scaleQty,
    average_cost: keep, // per-unit cost stays public
    created_at: keep,
    updated_at: keep,
  },
  investment_transactions: {
    id: keep,
    user_id: keep,
    account_id: keep,
    transaction_id: keep,
    transaction_split_id: keep,
    linked_transaction_id: keep,
    security_id: keep,
    funding_account_id: keep,
    action: keep,
    transaction_date: keep,
    quantity: scaleQty,
    price: keep, // public per-unit price
    commission: scale,
    total_amount: scale,
    exchange_rate: keep,
    description: drop,
    created_at: keep,
    updated_at: keep,
  },
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
  security_tags: { security_id: keep, tag_id: keep },
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
  budget_categories: {
    id: keep,
    budget_id: keep,
    category_id: keep,
    transfer_account_id: keep,
    is_transfer: keep,
    category_group: keep,
    amount: scale,
    is_income: keep,
    rollover_type: keep,
    rollover_cap: scale,
    flex_group: mask, // user-authored group name
    alert_warn_percent: keep,
    alert_critical_percent: keep,
    notes: drop,
    sort_order: keep,
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
  budget_alerts: {
    id: keep,
    user_id: keep,
    budget_id: keep,
    budget_category_id: keep,
    alert_type: keep,
    severity: keep,
    title: konst("***"), // NOT NULL
    message: konst("***"), // NOT NULL
    data: drop, // amounts/names in JSON; alerts regenerate anyway
    is_read: keep,
    is_email_sent: keep,
    period_start: keep,
    created_at: keep,
    dismissed_at: keep,
  },
  custom_reports: {
    id: keep,
    user_id: keep,
    name: mask,
    description: drop,
    icon: keep,
    background_color: keep,
    view_type: keep,
    timeframe_type: keep,
    group_by: keep,
    filters: jsonb("reportFilters"),
    config: keep, // enums/dates only
    is_favourite: keep,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
  investment_reports: {
    id: keep,
    user_id: keep,
    name: mask,
    description: drop,
    icon: keep,
    background_color: keep,
    group_by: keep,
    config: keep,
    is_favourite: keep,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
  import_column_mappings: {
    id: keep,
    user_id: keep,
    name: mask,
    column_mappings: keep, // CSV header names, needed to reproduce import bugs
    transfer_rules: jsonb("transferRules"),
    created_at: keep,
    updated_at: keep,
  },
  monthly_account_balances: {
    id: keep,
    user_id: keep,
    account_id: keep,
    month: keep,
    balance: scale,
    market_value: scale,
    created_at: keep,
    updated_at: keep,
  },
  auto_backup_settings: {
    user_id: keep,
    enabled: keep,
    folder_path: konst(""), // NOT NULL; may contain a username
    frequency: keep,
    backup_time: keep,
    timezone: konst("UTC"),
    retention_daily: keep,
    retention_weekly: keep,
    retention_monthly: keep,
    last_backup_at: keep,
    last_backup_status: keep,
    last_backup_error: drop,
    next_backup_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  monte_carlo_scenarios: {
    id: keep,
    user_id: keep,
    name: mask,
    description: drop,
    account_ids: keep, // UUID array, remapped + scoped by closure
    starting_value: scale,
    use_current_balance: keep,
    years_to_retirement: keep,
    annual_contribution: scale,
    contribution_growth_rate: keep, // rate
    years_in_retirement: keep,
    annual_withdrawal: scale,
    expected_return: keep,
    volatility: keep,
    inflation_rate: keep,
    show_real_values: keep,
    use_historical_returns: keep,
    simulation_count: keep,
    target_value: scale,
    random_seed: keep,
    is_favourite: keep,
    sort_order: keep,
    last_run_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  monte_carlo_cash_flows: {
    id: keep,
    scenario_id: keep,
    name: mask,
    amount: scale,
    flow_type: keep,
    start_year: keep,
    end_year: keep,
    inflation_adjust: keep,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
};

/**
 * Optional content sections the user can exclude. Each maps to the tables it
 * owns; when off, those tables are omitted and the FK columns pointing into
 * them are repaired by the referential-integrity scrub; non-FK references are
 * reset via SECTION_NONFK_CLEANUP so the trimmed backup still restores.
 * Tables not owned by any section are always included (the account core).
 */
export type SupportBackupSection =
  | "investments"
  | "scheduled"
  | "budgets"
  | "reports"
  | "importMappings"
  | "autoBackup";

export const SECTION_TABLES: Record<SupportBackupSection, string[]> = {
  investments: [
    "securities",
    "security_prices",
    "holdings",
    "investment_transactions",
    "security_tags",
  ],
  scheduled: [
    "scheduled_transactions",
    "scheduled_transaction_splits",
    "scheduled_transaction_overrides",
    "scheduled_transaction_split_tags",
  ],
  budgets: [
    "budgets",
    "budget_categories",
    "budget_periods",
    "budget_period_categories",
    "budget_alerts",
  ],
  reports: [
    "custom_reports",
    "investment_reports",
    "monte_carlo_scenarios",
    "monte_carlo_cash_flows",
  ],
  importMappings: ["import_column_mappings"],
  autoBackup: ["auto_backup_settings"],
};

/**
 * Cleanups a disabled section needs that the referential-integrity scrub can't
 * do on its own. The scrub already nulls/drops every real FK pointing at a
 * removed table, so those cases are NOT listed here (that would duplicate it).
 * What remains is non-FK references the scrub can't see: id arrays and JSONB
 * blobs. Today the only one is `favourite_report_ids` (a UUID text[] with no
 * FK), reset when the reports section is off.
 */
export interface SectionCleanup {
  table: string;
  column: string;
  resetTo: unknown;
}

export const SECTION_NONFK_CLEANUP: Partial<
  Record<SupportBackupSection, SectionCleanup[]>
> = {
  reports: [
    { table: "user_preferences", column: "favourite_report_ids", resetTo: [] },
  ],
};

/** All tables owned by any section (i.e. not part of the always-in core). */
export const SECTIONED_TABLES: ReadonlySet<string> = new Set(
  Object.values(SECTION_TABLES).flat(),
);
