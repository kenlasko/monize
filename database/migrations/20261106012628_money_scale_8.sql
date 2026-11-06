-- Widens the money columns of every table outside shared expenses from
-- NUMERIC(20,4) to NUMERIC(24,8): 50 columns in 23 tables
-- (docs/specs/money-precision.md, decision 1).
--
-- Scale 8 is the most places a currency may carry (a coin: a 2,500-sat network
-- fee is 0.00002500 BTC, which scale 4 stores as zero). A currency's money
-- precision is max(4, decimal_places), so every fiat amount keeps being
-- written and rounded at four places exactly as before; only a coin uses the
-- extra room.
--
-- Precision goes 20 -> 24 rather than staying at 20 so the integer part keeps
-- the 16 digits it has today. NUMERIC(20,8) would leave 12, and this migration
-- would then fail on an existing IDR or VND balance above 10^12; a widening
-- migration must not be able to reject existing data.
--
-- Not widened, by design: shared_entries, shared_allocations and
-- shared_ledger_links keep NUMERIC(20,4). Shared expenses are fiat-only (spec
-- section 10: a group's currency must be fiat) and their arithmetic is exact
-- at four places, so scale 4 is their final shape.
--
-- Rolling deployment: the 1.20.0 release reads and writes the new shape
-- unchanged. A 4-place value is an 8-place value, so its inserts and updates
-- are valid, and the rows it reads hold the same numbers (a stored 5420.5000
-- reads back as 5420.50000000, which Number() parses to the same double).
-- No function, view or RETURNS TABLE names the old type. One exception for the
-- length of the rollout: 1.20.0's shared-expense finance integration reads a
-- bank movement's transactions.amount (and its split amounts) as a raw string
-- and refuses one with more than four places, so on a 1.20.0 pod matching or
-- booking a shared expense against a bank movement can answer "Enter a valid
-- amount at the supported currency precision" until the rollout completes.
-- Nothing is written wrongly; 1.21.0 accepts the zero-padded digits
-- (shared-money.ts fixedUnits).
--
-- The marker below is required by migration:lint, whose contract-without-expand
-- rule reads every ALTER COLUMN ... TYPE as a contract. This one is not: it
-- widens, the widened type is the final shape, and no contract step follows.
-- contract-after: 1.21.0
--
-- Idempotent: ALTER COLUMN ... TYPE to the type a column already has is a
-- no-op on a re-run and on a fresh install from schema.sql.
--
-- Note for operators: these are type changes, so PostgreSQL rewrites each table
-- under an ACCESS EXCLUSIVE lock, one table at a time. transactions is the
-- largest and takes the longest; expect time proportional to its row count,
-- during which reads and writes of that table wait.

ALTER TABLE accounts
  ALTER COLUMN opening_balance TYPE NUMERIC(24, 8),
  ALTER COLUMN current_balance TYPE NUMERIC(24, 8),
  ALTER COLUMN credit_limit TYPE NUMERIC(24, 8),
  ALTER COLUMN low_balance_threshold TYPE NUMERIC(24, 8),
  ALTER COLUMN high_balance_threshold TYPE NUMERIC(24, 8),
  ALTER COLUMN payment_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN extra_payment_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN original_principal TYPE NUMERIC(24, 8);

-- Changing payment_amount's type makes PostgreSQL rebuild this CHECK from its
-- deparsed text, which re-parses `mortgage_type IN (...)` into a different
-- (equivalent) expression tree than schema.sql's. Re-adding it from source
-- keeps a migrated database identical to a fresh install. Same definition as
-- 20261003000246_accounts_payment_amount_method_check.sql.
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_payment_amount_method_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_payment_amount_method_check
  CHECK (
    payment_amount IS NULL
    OR mortgage_type IS NULL
    OR mortgage_type IN ('ANNUITY', 'CANADIAN_FIXED')
  );

ALTER TABLE transactions
  ALTER COLUMN amount TYPE NUMERIC(24, 8),
  ALTER COLUMN original_amount TYPE NUMERIC(24, 8);

ALTER TABLE transaction_splits
  ALTER COLUMN amount TYPE NUMERIC(24, 8);

ALTER TABLE email_receipt_links
  ALTER COLUMN part_amount TYPE NUMERIC(24, 8);

ALTER TABLE scheduled_transactions
  ALTER COLUMN amount TYPE NUMERIC(24, 8),
  ALTER COLUMN original_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN investment_commission TYPE NUMERIC(24, 8),
  ALTER COLUMN investment_total_amount TYPE NUMERIC(24, 8);

ALTER TABLE scheduled_transaction_splits
  ALTER COLUMN amount TYPE NUMERIC(24, 8),
  ALTER COLUMN investment_commission TYPE NUMERIC(24, 8);

ALTER TABLE scheduled_transaction_overrides
  ALTER COLUMN amount TYPE NUMERIC(24, 8),
  ALTER COLUMN investment_total_amount TYPE NUMERIC(24, 8);

ALTER TABLE investment_transactions
  ALTER COLUMN commission TYPE NUMERIC(24, 8),
  ALTER COLUMN total_amount TYPE NUMERIC(24, 8);

ALTER TABLE monthly_account_balances
  ALTER COLUMN balance TYPE NUMERIC(24, 8),
  ALTER COLUMN market_value TYPE NUMERIC(24, 8);

ALTER TABLE budgets
  ALTER COLUMN base_income TYPE NUMERIC(24, 8);

ALTER TABLE budget_categories
  ALTER COLUMN amount TYPE NUMERIC(24, 8),
  ALTER COLUMN rollover_cap TYPE NUMERIC(24, 8);

ALTER TABLE budget_periods
  ALTER COLUMN actual_income TYPE NUMERIC(24, 8),
  ALTER COLUMN actual_expenses TYPE NUMERIC(24, 8),
  ALTER COLUMN total_budgeted TYPE NUMERIC(24, 8);

ALTER TABLE budget_period_categories
  ALTER COLUMN budgeted_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN rollover_in TYPE NUMERIC(24, 8),
  ALTER COLUMN actual_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN effective_budget TYPE NUMERIC(24, 8),
  ALTER COLUMN rollover_out TYPE NUMERIC(24, 8);

ALTER TABLE notification_portfolio_state
  ALTER COLUMN baseline_value TYPE NUMERIC(24, 8);

ALTER TABLE bank_sync_accounts
  ALTER COLUMN bank_balance TYPE NUMERIC(24, 8);

ALTER TABLE monte_carlo_scenarios
  ALTER COLUMN starting_value TYPE NUMERIC(24, 8),
  ALTER COLUMN annual_contribution TYPE NUMERIC(24, 8),
  ALTER COLUMN annual_withdrawal TYPE NUMERIC(24, 8),
  ALTER COLUMN target_value TYPE NUMERIC(24, 8);

ALTER TABLE monte_carlo_cash_flows
  ALTER COLUMN amount TYPE NUMERIC(24, 8);

ALTER TABLE loan_scenarios
  ALTER COLUMN recurring_extra_amount TYPE NUMERIC(24, 8),
  ALTER COLUMN target_monthly_payment TYPE NUMERIC(24, 8);

ALTER TABLE loan_rate_changes
  ALTER COLUMN new_payment_amount TYPE NUMERIC(24, 8);

ALTER TABLE gem_strategies
  ALTER COLUMN commission_amount TYPE NUMERIC(24, 8);

ALTER TABLE warranties
  ALTER COLUMN purchase_price TYPE NUMERIC(24, 8);

ALTER TABLE payroll_deduction_rules
  ALTER COLUMN yearly_maximum TYPE NUMERIC(24, 8),
  ALTER COLUMN expected_per_paycheque TYPE NUMERIC(24, 8);

ALTER TABLE loan_fees
  ALTER COLUMN amount TYPE NUMERIC(24, 8);
