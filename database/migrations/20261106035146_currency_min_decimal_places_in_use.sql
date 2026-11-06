-- The fewest decimal places that every stored amount in a currency fits.
--
-- `CurrenciesService.assertDecimalPlacesFit` refuses lowering a currency's
-- `decimal_places` below what stored amounts already carry (INV-MONEY-001). It
-- scanned in the caller's transaction, under the caller's row-level security,
-- so it saw only the editing user's rows: another user's 8-place rows in the
-- same currency were missed and the lowering then broke their later writes.
--
-- This function answers the question globally. SECURITY DEFINER with a pinned
-- search_path, run in the caller's transaction after the caller locks the
-- currency row, EXECUTE revoked from PUBLIC; db-init grants it to the runtime
-- role (`backend/src/common/db/app-role.ts`). A single pass: the largest scale
-- of any stored amount once trailing zeros are dropped, which is the smallest
-- p for which `amount = ROUND(amount, p)` holds for every row.
--
-- Idempotent: CREATE OR REPLACE, then a COMMENT and a REVOKE that re-apply
-- cleanly.
CREATE OR REPLACE FUNCTION currency_min_decimal_places_in_use(p_code VARCHAR)
RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(MAX(scale(trim_scale(amounts.amount))), 0)::smallint
  FROM (
    SELECT t.amount AS amount
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.currency_code = p_code
    UNION ALL SELECT t.original_amount
      FROM transactions t
      WHERE t.original_currency_code = p_code
    UNION ALL SELECT s.amount
      FROM transaction_splits s
      JOIN transactions t ON t.id = s.transaction_id
      JOIN accounts a ON a.id = t.account_id
      WHERE a.currency_code = p_code
    UNION ALL SELECT v.amount
      FROM accounts a
      CROSS JOIN LATERAL (VALUES
        (a.opening_balance), (a.current_balance), (a.credit_limit),
        (a.low_balance_threshold), (a.high_balance_threshold)
      ) AS v(amount)
      WHERE a.currency_code = p_code
    UNION ALL SELECT st.amount
      FROM scheduled_transactions st JOIN accounts a ON a.id = st.account_id
      WHERE a.currency_code = p_code
    UNION ALL SELECT st.original_amount
      FROM scheduled_transactions st
      WHERE st.original_currency_code = p_code
    UNION ALL SELECT ss.amount
      FROM scheduled_transaction_splits ss
      JOIN scheduled_transactions st ON st.id = ss.scheduled_transaction_id
      JOIN accounts a ON a.id = st.account_id
      WHERE a.currency_code = p_code
    UNION ALL SELECT so.amount
      FROM scheduled_transaction_overrides so
      JOIN scheduled_transactions st ON st.id = so.scheduled_transaction_id
      JOIN accounts a ON a.id = st.account_id
      WHERE a.currency_code = p_code
  ) AS amounts
$$;

COMMENT ON FUNCTION currency_min_decimal_places_in_use(VARCHAR) IS
  'The smallest number of decimal places (0..8) that every stored amount in '
  'currency p_code fits without losing a digit, across every user: '
  'transactions, their splits, account balances and thresholds, scheduled '
  'transactions, their splits and overrides. 0 when nothing is stored. '
  'SECURITY DEFINER so the answer is global rather than the calling tenant''s '
  'view of it; the decimal-places lowering gate (INV-MONEY-001) runs it in '
  'its transaction after locking the currency row. Held to the referencing '
  'columns by currency-references.spec.ts.';

REVOKE ALL ON FUNCTION currency_min_decimal_places_in_use(VARCHAR) FROM PUBLIC;
