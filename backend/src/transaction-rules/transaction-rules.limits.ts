/** Design section 4: at most 200 rules per user. */
export const MAX_TRANSACTION_RULES_PER_USER = 200;

/** Manual run and test panel: rows examined per call (default and ceiling). */
export const DEFAULT_RULE_RUN_LIMIT = 200;
export const MAX_RULE_RUN_LIMIT = 1000;
/**
 * Test match: the newest rows whose condition is evaluated per request (no
 * write, so a wider scan than a run), and the page of matches returned.
 */
export const MAX_RULE_MATCH_SCAN = 5000;
export const DEFAULT_RULE_MATCH_PAGE_LIMIT = 10;
export const MAX_RULE_MATCH_PAGE_LIMIT = 50;
/** Accounts a run may be narrowed to. */
export const MAX_RULE_RUN_ACCOUNTS = 100;
/** Latest applications returned by the trace read (default and ceiling). */
export const DEFAULT_RULE_APPLICATIONS_LIMIT = 50;
export const MAX_RULE_APPLICATIONS_LIMIT = 200;
/** Rules the assistant and MCP list tool returns per call (default and ceiling). */
export const DEFAULT_RULE_TOOL_LIST_LIMIT = 50;
export const MAX_RULE_TOOL_LIST_LIMIT = 200;
/** Tags a row sent to the row explanation may carry (a row holds far fewer). */
export const MAX_EXPLAIN_ROW_TAGS = 50;
/** `payees.name` and `transactions.payee_name` are varchar(255). */
export const MAX_EXPLAIN_ROW_PAYEE_LENGTH = 255;
/** `transactions.reference_number` is varchar(100). */
export const MAX_EXPLAIN_ROW_REFERENCE_LENGTH = 100;
/** `transactions.amount` is `NUMERIC(24,8)`: sixteen integer digits at most. */
export const MAX_EXPLAIN_ROW_AMOUNT_DIGITS = 16;
/**
 * The largest amount a rule literal or a captured split part may name, far
 * beyond any real amount; a bound on the rule, not on the column.
 */
export const RULE_MONEY_ABS_MAX = 10 ** 12;
/**
 * `settle_loan_installment`: the most days a row may be dated before or after
 * the installment it pays (`dueDateWindow.daysBefore` / `daysAfter`, spec
 * `docs/specs/loan-installment-settlement.md` section 5.1).
 */
export const MAX_LOAN_SETTLEMENT_WINDOW_DAYS = 31;
