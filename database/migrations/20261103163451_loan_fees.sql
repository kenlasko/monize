-- Mortgage fees (docs/specs/mortgage-fees.md): insurance, tax or other fees
-- collected with a mortgage payment, each a category line of the payment
-- template priced per installment from its own terms (INV-LOAN-011).
--
-- Expand only; idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS loan_fees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The category of the fee's template line: how the loan pricing
    -- identifies that line, so one fee per category per mortgage.
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    -- Written as the fee line's memo.
    name VARCHAR(100) NOT NULL,
    calculation VARCHAR(30) NOT NULL,
    basis VARCHAR(20) NOT NULL DEFAULT 'PER_PAYMENT',
    -- A FIXED fee's money, in the mortgage's currency.
    amount NUMERIC(20,4),
    -- A percentage fee's rate, in percent of its base.
    rate NUMERIC(10,6),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_loan_fees_calculation CHECK (calculation IN ('FIXED', 'PERCENT_CURRENT_BALANCE', 'PERCENT_ORIGINAL_BALANCE')),
    CONSTRAINT chk_loan_fees_basis CHECK (basis IN ('PER_PAYMENT', 'ANNUAL')),
    CONSTRAINT chk_loan_fees_value CHECK (
        (calculation = 'FIXED' AND amount IS NOT NULL AND amount > 0 AND rate IS NULL)
        OR (calculation <> 'FIXED' AND rate IS NOT NULL AND rate > 0 AND rate <= 100 AND amount IS NULL)
    ),
    CONSTRAINT uq_loan_fees_account_category UNIQUE (account_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_loan_fees_user ON loan_fees(user_id);
CREATE INDEX IF NOT EXISTS idx_loan_fees_category ON loan_fees(category_id);

DROP TRIGGER IF EXISTS update_loan_fees_updated_at ON loan_fees;
CREATE TRIGGER update_loan_fees_updated_at
  BEFORE UPDATE ON loan_fees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE loan_fees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loan_fees_isolation ON loan_fees;
CREATE POLICY loan_fees_isolation ON loan_fees
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
