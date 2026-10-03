import {
  drop,
  jsonb,
  keep,
  konst,
  mask,
  scale,
  scaleQty,
} from "./support-backup-rule-kinds";
import { PLANNING_RULES } from "./support-backup-rules.planning";

/**
 * Per-column de-identification rules for the support backup. This registry is
 * the single source of truth for what happens to every exported column, and it
 * is an ALLOWLIST: a column with no rule is dropped from the output, and the
 * golden test (support-backup-coverage) fails when the live schema gains a
 * column this registry does not classify -- so a future migration cannot
 * silently start leaking a new field.
 */
// The rule kinds and their shorthands live in their own file so the registry
// can be split without either half importing the other; re-exported here so
// existing import sites are unchanged.
export type { ColumnRule, TableRules } from "./support-backup-rule-kinds";

import type { TableRules } from "./support-backup-rule-kinds";

/**
 * Tables never written to a support backup regardless of section selection.
 * `ai_provider_configs` holds encrypted API keys and endpoint URLs with zero
 * diagnostic value for a finance bug, so it is dropped wholesale, and
 * `payee_lookup_settings` holds a Google Places key for the same reason. The two
 * attachment tables carry user-uploaded receipts/documents: `attachment_blobs`
 * is raw file bytes (a NOT NULL BYTEA with no useful de-identified form) and
 * `transaction_attachments` is their metadata (filenames can embed PII), so
 * both are omitted from the de-identified support backup. Their columns are
 * intentionally absent from RULES below; the golden test skips them.
 */
export const ALWAYS_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "ai_provider_configs",
  "payee_lookup_settings",
  "transaction_attachments",
  "attachment_blobs",
  "push_chart_artifacts",
]);

export const RULES: Record<string, TableRules> = {
  // How many Google Places requests a month cost, and nothing else: a user id
  // (kept as an FK everywhere here), a YYYY-MM, and a counter. Nothing about
  // it names a payee, so nothing needs masking -- and the count is exactly
  // what a support case about a cap would be asking to see.
  payee_lookup_usage: {
    user_id: keep,
    month: keep,
    google_places_requests: keep,
  },
  currencies: {
    code: keep,
    name: keep,
    symbol: keep,
    decimal_places: keep,
    is_active: keep,
    created_by_user_id: keep,
    created_at: keep,
  },
  // A note is the user's own writing about their own day: whatever they put in
  // it, a support copy has no use for the text and every reason not to carry
  // it. Replaced whole, not masked -- a masked note would still say how long it
  // was and which days carried one, which is the same disclosure made quieter.
  //
  // `konst`, not `drop`: the column is NOT NULL and
  // `ck_calendar_day_notes_body_length` refuses an empty string, so a null (or
  // a "") is a row no restore can insert, and a support backup restores through
  // the same path as any other.
  calendar_day_notes: {
    id: keep,
    user_id: keep,
    note_date: keep,
    end_date: keep,
    body: konst("***"), // NOT NULL, CHECK char_length >= 1
    created_at: keep,
    updated_at: keep,
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
    lock_reconciled_transactions: keep,
    payee_contact_lookup_enabled: keep,
    language: keep,
    last_client_timezone: drop, // location hint
    default_map_provider: keep,
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
    website: drop, // a public URL names the payee the masked name hides
    // A brand favicon names the payee just as its website does, so the bytes
    // go and the flag is forced consistent with their absence.
    logo_data: drop,
    logo_content_type: drop,
    has_logo: konst(false),
    logo_fetched_at: drop,
    // Contact details are direct personal data and name the payee outright,
    // which is the whole point of masking the name.
    address: drop,
    email: drop,
    phone: drop,
    // A lookup's timestamp and source say when and how the (dropped) contact
    // details were found; neither names the payee.
    contact_lookup_at: keep,
    contact_lookup_source: keep,
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
    low_balance_threshold: scale, // a money figure, scaled like every amount
    high_balance_threshold: scale,
    low_alert_armed: keep, // the crossing latch, a boolean
    high_alert_armed: keep,
    is_favourite: keep,
    favourite_sort_order: keep,
    exclude_from_net_worth: keep,
    payment_amount: scale,
    extra_payment_amount: scale, // money like payment_amount, scaled the same way
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
    mortgage_type: keep,
    prepayment_mode: keep,
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
  transaction_rules: {
    id: keep,
    user_id: keep,
    name: mask,
    enabled: keep,
    position: keep,
    triggers: keep, // a subset of {create, import}
    // Free-text match patterns (payee text, descriptions, memos) and the
    // user's own review instructions, nested in documents that also carry the
    // ids of accounts, payees, categories and tags. Both are NOT NULL, so they
    // are replaced by an empty document rather than dropped; a rule restored
    // from a support backup is invalid and skipped, never evaluated.
    condition: konst({}),
    actions: konst([]),
    stop_processing: keep,
    active_from: keep, // a date, the first day the rule applies to
    active_to: keep, // a date, the last day the rule applies to
    revision: keep,
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
    original_amount: scale, // private money magnitude, in foreign currency
    original_currency_code: keep, // public reference value
    exchange_rate: keep, // public FX rate
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
    investment_exchange_rate_from_currency: keep, // currency code, structure
    investment_exchange_rate_to_currency: keep,
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
    investment_exchange_rate_from_currency: keep, // currency code, structure
    investment_exchange_rate_to_currency: keep,
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
  scheduled_transaction_postings: {
    // Every column is structure or a date: which occurrence of which schedule
    // was posted, and when. Nothing here names a payee, an amount or free text,
    // so there is nothing to mask or drop.
    id: keep,
    scheduled_transaction_id: keep,
    original_due_date: keep,
    posted_date: keep,
    created_at: keep,
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
    price_alert_percent: keep,
    price_chart_enabled: keep,
    sector: keep,
    industry: keep,
    sector_weightings: keep, // public weightings
    country_weightings: keep,
    asset_weightings: jsonb("assetWeightings"), // free-text class names
    sector_data_updated_at: keep,
    quote_provider: keep,
    // The exchange's regular session, from the provider. Public reference data
    // about the venue, not the holder, and far too coarse to undo the symbol
    // mask -- 09:30-16:00 America/New_York names an exchange, not an instrument.
    market_timezone: keep,
    market_open_time: keep,
    market_close_time: keep,
    website: drop, // a public URL names the instrument the masked symbol hides
    ir_website: drop,
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
    quoted_at: keep, // when the quote was struck; price_date beside it is kept too
    created_at: keep,
  },
  security_documents: {
    id: keep,
    user_id: keep,
    security_id: keep,
    document_type: keep, // a factsheet is a factsheet
    name: mask, // the user's own wording, and it can name them
    document_date: keep,
    url: konst(""), // NOT NULL; an address can identify the holder or the account it came from
    notes: drop, // free text
    created_at: keep,
    updated_at: keep,
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
    // An enum flag, like transactions.status: it re-identifies nobody, and a
    // support backup that dropped it could not reproduce a VOID row's
    // exclusion from holdings and balances.
    status: keep,
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
  notifications: {
    id: keep,
    user_id: keep,
    budget_id: keep,
    budget_category_id: keep,
    alert_type: keep,
    severity: keep,
    title: konst("***"), // NOT NULL
    message: konst("***"), // NOT NULL
    data: drop, // amounts/names in JSON; alerts regenerate anyway
    // An in-app path, so at most an id this row already keeps elsewhere.
    target: keep,
    is_read: keep,
    is_email_sent: keep,
    period_start: keep,
    created_at: keep,
    dismissed_at: keep,
    // Machine fingerprint (alert type + affected user id + date bucket);
    // the user id in it is the same identifier user_id already keeps.
    dedupe_key: keep,
  },
  notification_preferences: {
    user_id: keep,
    category: keep, // a derived NotificationCategory value, not free text
    email: keep, // report-mode email flag
    email_notification: keep, // notification-mode email flag
    throttle_minutes: keep, // an integer cooldown, not identifying
    push: keep, // web push channel flag
    unifiedpush: keep, // UnifiedPush channel flag
    created_at: keep,
    updated_at: keep,
  },
  notification_reminders: {
    id: keep,
    user_id: keep,
    source_notification_id: keep, // an id this backup already keeps elsewhere
    alert_type: keep,
    severity: keep,
    title: konst("***"), // free text template copy
    message: konst("***"), // free text template copy
    data: drop, // amounts/names in JSON, like notifications.data
    // An in-app path, so at most an id this row already keeps elsewhere.
    target: keep,
    // Fingerprint base (a dedupe key or an alert type); the same shape as
    // notifications.dedupe_key, which this classification keeps.
    dedupe_base: keep,
    repeat_mode: keep,
    interval_minutes: keep,
    next_fire_at: keep,
    last_fired_at: keep,
    fire_count: keep,
    stopped_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  notification_portfolio_state: {
    user_id: keep,
    move_alert_percent: keep, // the user's threshold, not identifying
    baseline_value: scale, // a money figure -- scaled like every other amount
    baseline_currency: keep, // an ISO currency code
    baseline_captured_on: keep, // a date
    // Derived per-security quantities and closes; dropped rather than scaled
    // one by one. The producer replaces a baseline without them on its next
    // run, so a restored support copy loses one day's comparison, nothing more.
    baseline_positions: drop,
    created_at: keep,
    updated_at: keep,
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
  // The planning tables -- Monte Carlo scenarios and GEM strategies -- live in
  // their own file (a separate area from the account core above), merged here
  // so every import site and the golden test still read one RULES map.
  ...PLANNING_RULES,
};

/**
 * Optional content sections the user can exclude. Each maps to the tables it
 * owns; when off, those tables are omitted and the FK columns pointing into
 * them are repaired by the referential-integrity scrub; non-FK references are
 * reset via SECTION_NONFK_CLEANUP so the trimmed backup still restores.
 * Tables not owned by any section are always included (the account core).
 */
// The section-to-tables mapping lives in its own file (a separate axis from the
// per-column rules above); re-exported here so existing import sites are
// unchanged.
export {
  SECTION_TABLES,
  SECTION_NONFK_CLEANUP,
  SECTIONED_TABLES,
} from "./support-backup-sections";
export type {
  SupportBackupSection,
  SectionCleanup,
} from "./support-backup-sections";
