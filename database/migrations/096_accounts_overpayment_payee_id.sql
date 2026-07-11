-- Per-loan overpayment payee match. Alongside (or instead of) the overpayment
-- category and memo, the user can designate a payee whose payments count as
-- standalone overpayments (100% principal, no interest). A payment to/from that
-- payee is flagged as an overpayment, so the schedule and rate detection treat
-- it as extra principal. Nullable; ON DELETE SET NULL so removing the payee
-- just clears the loan's setting.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS overpayment_payee_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_overpayment_payee'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT fk_accounts_overpayment_payee
      FOREIGN KEY (overpayment_payee_id) REFERENCES payees(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_overpayment_payee
  ON accounts(overpayment_payee_id);
