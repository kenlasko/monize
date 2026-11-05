-- Whether any row anywhere other than an activation references a currency code.
--
-- `currency_code_in_use_globally` answers "does anything still hold this
-- code?", and every currency's creator holds it through their own
-- `user_currency_preferences` row, so that answer is true from the moment a
-- currency exists. The kind-change gate (`CurrenciesService.update`,
-- `docs/specs/crypto-accounts.md` decision 8, INV-CRYPTO-001) asks a narrower
-- question: does any account, transaction, security, schedule, budget,
-- warranty, shared row, rate, coverage row, bond row or default-currency
-- preference use the code? An activation is a user's list, not a use: a kind
-- may still change while only activations hold the code.
--
-- Same shape as its sibling: SECURITY DEFINER so the answer is global rather
-- than the calling tenant's view of it, a pinned search_path, run in the
-- caller's transaction (after the caller locks the currency row), and EXECUTE
-- revoked from PUBLIC; db-init grants it to the runtime role
-- (`backend/src/common/db/app-role.ts`). `currency-references.spec.ts` holds
-- its body to every column that references currencies(code) except
-- user_currency_preferences.currency_code.
--
-- Idempotent: CREATE OR REPLACE, then a COMMENT and a REVOKE that re-apply
-- cleanly. The sibling is not changed.
CREATE OR REPLACE FUNCTION currency_code_referenced_by_data(p_code VARCHAR)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM shared_groups WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM shared_entries WHERE original_currency_code = p_code
    UNION ALL SELECT 1 FROM exchange_rates
      WHERE from_currency = p_code OR to_currency = p_code
    UNION ALL SELECT 1 FROM exchange_rate_coverage
      WHERE from_currency = p_code OR to_currency = p_code
    UNION ALL SELECT 1 FROM accounts WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM securities WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM bond_programs WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM bond_instruments WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM budgets WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM warranties WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = p_code
  )
$$;

COMMENT ON FUNCTION currency_code_referenced_by_data(VARCHAR) IS
  'True when any row anywhere other than a user_currency_preferences activation '
  'references currencies(code) = p_code. The kind-change gate: an activation is '
  'a list entry, not a use. SECURITY DEFINER so the answer is global; must '
  'consult every other FK to currencies(code) -- enforced by '
  'currency-references.spec.ts.';

REVOKE ALL ON FUNCTION currency_code_referenced_by_data(VARCHAR) FROM PUBLIC;
