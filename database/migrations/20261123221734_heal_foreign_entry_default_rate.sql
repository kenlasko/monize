-- A foreign-currency entry that inherited the column's default exchange_rate 1
-- (issue #2358).
--
-- From the foreign-entry feature (July 2026) until issue #2344, an update that
-- added originalAmount and originalCurrencyCode to a plain transaction without
-- naming a rate kept the plain row's default 1 and the account-currency amount
-- it already had: normalizeFxEntry never checks the amounts against the rate.
-- Since #2344 the reports read a 1 beside an original currency as a recorded
-- rate (ownRateSql, transactionRateBasis), so EUR 100 charged as USD 117.50 and
-- stored at 1 reads EUR 117.50, and the Foreign Currency Fees report derives a
-- USD 17.50 fee from it. The code fix stops new ones; this heals the rows
-- already written.
--
-- The amount the account was charged is the fact, so the repair is the rate
-- the row's own two amounts imply, with the account's foreign-transaction fee
-- backed out: exactly what resolveForeignEntry
-- (backend/src/common/foreign-entry.util.ts) stores for an edit that gives both
-- amounts and no rate, fxBaseFromCharged(amount, fee) / original_amount at
-- the rate's ten places. amount, original_amount and every balance are left
-- alone.
--
-- Only a 1 the amounts contradict is touched. A row whose amount is what
-- original_amount converts to at 1:1 with the fee (applyFxConversion, within
-- one unit of the account currency, the tolerance resolveForeignEntry allows)
-- reads correctly at 1 however it got there, and a genuine 1:1 entry looks
-- exactly like that, so those rows keep their 1.
--
-- Deliberately not healed:
--   * a row with a zero amount on either side, or amounts of opposite signs:
--     no positive rate can be derived from them;
--   * an income row on an account charging a 100% fee: the base behind it is
--     a division by zero;
--   * a derived rate the column cannot hold (at or above 1e10), or one that
--     rounds back to 1;
--   * a shared-expense ledger row (shared_expense_posting_id, or an account in
--     a shared group): the journal writes those, the old update path could not
--     reach them, and shared_protect_ledger_transaction refuses the edit.
--
-- The fee is the account's fx_fee_percent today, not the one in force when the
-- row was written; the row stores no other.
--
-- Re-runnable: a healed row no longer carries exchange_rate = 1, so a second
-- pass selects nothing.

WITH candidates AS (
    SELECT t.id,
           t.amount,
           t.original_amount,
           CASE WHEN a.fx_fee_percent > 0 THEN a.fx_fee_percent / 100 ELSE 0 END AS fee,
           -- moneyDecimalsFor: four places for fiat, a coin's own up to eight.
           GREATEST(4, LEAST(8, COALESCE(c.decimal_places, 2))) AS money_places,
           COALESCE(c.decimal_places, 2) AS currency_places
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN currencies c ON c.code = t.currency_code
    WHERE t.original_currency_code IS NOT NULL
      AND t.original_currency_code <> t.currency_code
      AND t.exchange_rate = 1
      AND t.amount <> 0
      AND t.original_amount <> 0
      AND sign(t.amount) = sign(t.original_amount)
      AND t.shared_expense_posting_id IS NULL
      AND a.shared_expense_group_id IS NULL
),
derived AS (
    SELECT id,
           amount,
           currency_places,
           -- applyFxConversion(original_amount, 1, fee)
           round(original_amount, money_places)
             - round(abs(round(original_amount, money_places)) * fee, money_places) AS at_par,
           -- fxBaseFromCharged(amount, fee) / original_amount. The NULLIFs
           -- make a division by zero a NULL rate, which the UPDATE skips,
           -- whatever order the planner evaluates the filters in.
           round(
             CASE
               WHEN fee = 0 THEN amount
               WHEN amount >= 0 THEN round(amount / NULLIF(1 - fee, 0), money_places)
               ELSE round(amount / (1 + fee), money_places)
             END / NULLIF(original_amount, 0),
             10
           ) AS rate
    FROM candidates
)
UPDATE transactions t
SET exchange_rate = d.rate
FROM derived d
WHERE t.id = d.id
  AND t.exchange_rate = 1
  AND abs(d.at_par - d.amount) > power(10::numeric, -d.currency_places)
  AND d.rate > 0
  AND d.rate < 1e10
  AND d.rate <> 1;
