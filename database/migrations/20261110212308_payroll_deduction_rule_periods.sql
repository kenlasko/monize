-- Payroll deduction figures per period (docs/specs/payroll-deductions.md
-- section 11): the maximum and the entered expected amount one rule uses
-- for the period starting on `period_start`, so a figure entered for next
-- year leaves the current period's room alone. A period with no row carries
-- the previous row forward; a rule with no row at all reads its own columns.
--
-- Expand only; idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS payroll_deduction_rule_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id UUID NOT NULL REFERENCES payroll_deduction_rules(id) ON DELETE CASCADE,
    -- The first day of the period these figures apply from.
    period_start DATE NOT NULL,
    yearly_maximum NUMERIC(24,8) NOT NULL CHECK (yearly_maximum >= 0),
    -- Read only when the bill carries no split line for the category.
    expected_per_paycheque NUMERIC(24,8) CHECK (expected_per_paycheque IS NULL OR expected_per_paycheque >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_payroll_deduction_rule_period UNIQUE (rule_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_payroll_deduction_rule_periods_user
    ON payroll_deduction_rule_periods(user_id);

DROP TRIGGER IF EXISTS update_payroll_deduction_rule_periods_updated_at ON payroll_deduction_rule_periods;
CREATE TRIGGER update_payroll_deduction_rule_periods_updated_at
  BEFORE UPDATE ON payroll_deduction_rule_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE payroll_deduction_rule_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_deduction_rule_periods_isolation ON payroll_deduction_rule_periods;
CREATE POLICY payroll_deduction_rule_periods_isolation ON payroll_deduction_rule_periods
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
