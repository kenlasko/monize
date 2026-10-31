-- Managed settlement accounts are private ledger projections. The journal does
-- not write them when a peer edits a shared entry.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS managed_purpose VARCHAR(30);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_expense_group_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS shared_expense_posting_id UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_shared_purpose_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_shared_purpose_check CHECK (
      (managed_purpose IS NULL AND shared_expense_group_id IS NULL) OR
      (managed_purpose = 'SHARED_SETTLEMENT' AND shared_expense_group_id IS NOT NULL
        AND account_type = 'OTHER' AND opening_balance = 0 AND linked_account_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_shared_group_fk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_shared_group_fk FOREIGN KEY (shared_expense_group_id) REFERENCES shared_groups(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_shared_posting_fk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_shared_posting_fk FOREIGN KEY (shared_expense_posting_id, user_id) REFERENCES shared_postings(id, user_id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_transactions_shared_posting ON transactions(shared_expense_posting_id) WHERE shared_expense_posting_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_shared_group ON accounts(user_id, shared_expense_group_id) WHERE shared_expense_group_id IS NOT NULL;

-- Every generic writer (UI, bulk, import, rules, AI, MCP and undo) reaches these
-- triggers. The bridge sets a posting-specific GUC inside withScopedDb only.
-- The existing authenticated restore scope may rebuild the user's whole ledger.
CREATE OR REPLACE FUNCTION shared_protect_ledger_transaction() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE posting UUID; target_account UUID; managed_group UUID; allowed_posting TEXT;
BEGIN
  IF current_setting('app.preserve_timestamps', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN posting := OLD.shared_expense_posting_id; target_account := OLD.account_id;
  ELSE posting := COALESCE(NEW.shared_expense_posting_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.shared_expense_posting_id END); target_account := NEW.account_id; END IF;
  SELECT shared_expense_group_id INTO managed_group FROM accounts WHERE id = target_account;
  allowed_posting := NULLIF(current_setting('app.shared_posting_id', true), '');
  IF posting IS NOT NULL AND allowed_posting = posting::text THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND posting IS NOT NULL AND NEW.status <> 'VOID' AND OLD.status <> 'VOID'
    AND (to_jsonb(NEW) - ARRAY['status', 'reconciled_date', 'description', 'payee_name', 'payee_id', 'updated_at']) =
        (to_jsonb(OLD) - ARRAY['status', 'reconciled_date', 'description', 'payee_name', 'payee_id', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF posting IS NOT NULL OR managed_group IS NOT NULL THEN
    RAISE EXCEPTION 'Review or unlink this row in Shared expenses before changing its financial values' USING ERRCODE = 'PSE01';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS shared_transactions_protect ON transactions;
CREATE TRIGGER shared_transactions_protect BEFORE INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION shared_protect_ledger_transaction();

CREATE OR REPLACE FUNCTION shared_protect_ledger_split() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parent_id UUID; posting UUID; target UUID; managed_group UUID;
BEGIN
  IF current_setting('app.preserve_timestamps', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN parent_id := OLD.transaction_id; target := OLD.transfer_account_id;
  ELSE parent_id := NEW.transaction_id; target := NEW.transfer_account_id; END IF;
  SELECT shared_expense_posting_id INTO posting FROM transactions WHERE id = parent_id;
  IF TG_OP = 'UPDATE' AND OLD.transaction_id <> NEW.transaction_id AND EXISTS (
    SELECT 1 FROM transactions WHERE id = OLD.transaction_id AND shared_expense_posting_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Unlink the original shared booking before moving a split' USING ERRCODE = 'PSE01';
  END IF;
  SELECT shared_expense_group_id INTO managed_group FROM accounts WHERE id = target;
  IF posting IS NOT NULL AND current_setting('app.shared_posting_id', true) = posting::text THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF posting IS NOT NULL OR managed_group IS NOT NULL THEN
    RAISE EXCEPTION 'Review or unlink this row in Shared expenses before changing its financial values' USING ERRCODE = 'PSE01';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS shared_splits_protect ON transaction_splits;
CREATE TRIGGER shared_splits_protect BEFORE INSERT OR UPDATE OR DELETE ON transaction_splits FOR EACH ROW EXECUTE FUNCTION shared_protect_ledger_split();

CREATE OR REPLACE FUNCTION shared_protect_ledger_account() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE group_key UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN group_key := OLD.shared_expense_group_id;
  ELSE group_key := COALESCE(NEW.shared_expense_group_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.shared_expense_group_id END); END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM accounts WHERE id = NEW.source_account_id AND managed_purpose = 'SHARED_SETTLEMENT') THEN
    RAISE EXCEPTION 'A shared settlement account is not a payment source' USING ERRCODE = 'PSE01';
  END IF;
  IF group_key IS NULL OR current_setting('app.preserve_timestamps', true) = 'on'
    OR current_setting('app.shared_group_id', true) = group_key::text THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Balance recomputation, naming and display preferences are allowed. Opening
  -- balance, identity, type, currency and closure remain bridge-managed.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['current_balance', 'updated_at', 'name', 'description', 'is_favourite', 'favourite_sort_order', 'exclude_from_net_worth']) =
      (to_jsonb(OLD) - ARRAY['current_balance', 'updated_at', 'name', 'description', 'is_favourite', 'favourite_sort_order', 'exclude_from_net_worth']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Manage this settlement account from Shared expenses' USING ERRCODE = 'PSE01';
END $$;
DROP TRIGGER IF EXISTS shared_accounts_protect ON accounts;
CREATE TRIGGER shared_accounts_protect BEFORE INSERT OR UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION shared_protect_ledger_account();

-- A future manual posting must not target the managed clearing ledger either.
CREATE OR REPLACE FUNCTION shared_protect_scheduled_target() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_each_text(to_jsonb(NEW)) f JOIN accounts a ON a.id = CASE WHEN f.key IN ('account_id', 'transfer_account_id', 'investment_funding_account_id', 'settlement_account_id') THEN f.value::uuid END
      WHERE f.key IN ('account_id', 'transfer_account_id', 'investment_funding_account_id', 'settlement_account_id')
        AND f.value IS NOT NULL AND a.managed_purpose = 'SHARED_SETTLEMENT') THEN
    RAISE EXCEPTION 'Schedule real cash movements on a bank account, not the shared settlement account' USING ERRCODE = 'PSE01';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shared_schedule_target ON scheduled_transactions;
CREATE TRIGGER shared_schedule_target BEFORE INSERT OR UPDATE ON scheduled_transactions FOR EACH ROW EXECUTE FUNCTION shared_protect_scheduled_target();
DROP TRIGGER IF EXISTS shared_schedule_split_target ON scheduled_transaction_splits;
CREATE TRIGGER shared_schedule_split_target BEFORE INSERT OR UPDATE ON scheduled_transaction_splits FOR EACH ROW EXECUTE FUNCTION shared_protect_scheduled_target();
DROP TRIGGER IF EXISTS shared_schedule_override_target ON scheduled_transaction_overrides;
CREATE TRIGGER shared_schedule_override_target BEFORE INSERT OR UPDATE ON scheduled_transaction_overrides FOR EACH ROW EXECUTE FUNCTION shared_protect_scheduled_target();
