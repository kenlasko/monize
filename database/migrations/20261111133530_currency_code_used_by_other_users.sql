-- Whether any user other than the given one activates a currency code or holds
-- data in it.
--
-- `currencies` is shared: a coin added by one user is adopted by every later
-- user who adds the same code, and only its creator may edit it. A first price
-- symbol on a CRYPTO coin that had none decides the price every holder's wallet
-- is valued at, so `CurrenciesService.update` refuses it once another user
-- activates the code or holds data in it (`docs/specs/crypto-accounts.md`
-- section 5, INV-CRYPTO-001). The creator may still price a coin only they use.
--
-- Global reference data with no owner (exchange_rates, exchange_rate_coverage,
-- bond_programs, bond_instruments) is no user's use and is not consulted. A
-- shared group or entry counts when its group has an owner or an active member
-- other than the given user.
--
-- Same shape as currency_code_referenced_by_data: SECURITY DEFINER so the answer
-- is global rather than the calling tenant's view of it, a pinned search_path,
-- run in the caller's transaction after the caller locks the currency row, and
-- EXECUTE revoked from PUBLIC; db-init grants it to the runtime role
-- (`backend/src/common/db/app-role.ts`).
--
-- Idempotent: CREATE OR REPLACE, then a COMMENT and a REVOKE that re-apply
-- cleanly.
CREATE OR REPLACE FUNCTION currency_code_used_by_other_users(p_code VARCHAR, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_currency_preferences
      WHERE currency_code = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM user_preferences
      WHERE default_currency = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM accounts
      WHERE currency_code = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM transactions
      WHERE (currency_code = p_code OR original_currency_code = p_code)
        AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM securities
      WHERE currency_code = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE (currency_code = p_code OR original_currency_code = p_code)
        AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM budgets
      WHERE currency_code = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM warranties
      WHERE currency_code = p_code AND user_id <> p_user_id
    UNION ALL SELECT 1 FROM shared_groups g
      WHERE g.currency_code = p_code
        AND (g.owner_user_id <> p_user_id OR EXISTS (
          SELECT 1 FROM shared_memberships m
           WHERE m.group_id = g.id AND m.revoked_at IS NULL
             AND m.user_id IS DISTINCT FROM p_user_id))
    UNION ALL SELECT 1 FROM shared_entries e
      JOIN shared_groups g ON g.id = e.group_id
      WHERE e.original_currency_code = p_code
        AND (g.owner_user_id <> p_user_id OR EXISTS (
          SELECT 1 FROM shared_memberships m
           WHERE m.group_id = g.id AND m.revoked_at IS NULL
             AND m.user_id IS DISTINCT FROM p_user_id))
  )
$$;

COMMENT ON FUNCTION currency_code_used_by_other_users(VARCHAR, uuid) IS
  'True when any user other than p_user_id activates currencies(code) = p_code '
  'or holds data in it, including a shared group or entry with another '
  'participant. The first-price-symbol gate: a coin''s creator may price a coin '
  'only they use. SECURITY DEFINER so the answer sees other tenants; must consult '
  'every FK to currencies(code) whose table has an owner -- enforced by '
  'currency-references.spec.ts.';

REVOKE ALL ON FUNCTION currency_code_used_by_other_users(VARCHAR, uuid) FROM PUBLIC;
