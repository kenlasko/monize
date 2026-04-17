-- Round historical investment-linked cash transaction amounts to their
-- account currency's decimal precision. Before the rounding fix, cash
-- transactions created by investment actions (BUY / SELL / DIVIDEND / etc.)
-- stored the raw 4-decimal result of quantity * price * exchange_rate,
-- causing sub-cent residue to accumulate in displayed balances (e.g. a
-- $1000 deposit showing as $999.99, or summed activity showing -$0.00).
-- New transactions are rounded at insert time; this migration backfills
-- the correction for existing rows and rebuilds the current_balance for
-- the affected cash accounts.
--
-- Monthly snapshots (monthly_account_balances) are rebuilt from the
-- transactions table by NetWorthService.recalculateAllAccounts. After
-- this migration runs, clicking "Recalculate" on the Net Worth Report
-- will regenerate snapshots from the corrected transaction amounts.

-- Round the amount column for every cash transaction that was linked
-- from an investment_transactions row, then track which accounts changed.
CREATE TEMP TABLE _rounded_cash_tx_accounts (account_id UUID PRIMARY KEY);

WITH to_round AS (
    SELECT t.id,
           t.account_id,
           ROUND(t.amount::numeric, c.decimal_places) AS new_amount
    FROM transactions t
    INNER JOIN investment_transactions it ON it.transaction_id = t.id
    INNER JOIN accounts a ON a.id = t.account_id
    INNER JOIN currencies c ON c.code = a.currency_code
    WHERE t.amount IS DISTINCT FROM ROUND(t.amount::numeric, c.decimal_places)
),
updated AS (
    UPDATE transactions t
    SET amount = tr.new_amount
    FROM to_round tr
    WHERE t.id = tr.id
    RETURNING t.account_id
)
INSERT INTO _rounded_cash_tx_accounts (account_id)
SELECT DISTINCT account_id FROM updated
ON CONFLICT DO NOTHING;

-- Rebuild current_balance for each affected account from its opening
-- balance plus the sum of all non-void, non-child transactions. This
-- matches the derivation used by NetWorthService.recalculateCashAccount.
UPDATE accounts a
SET current_balance = COALESCE(a.opening_balance, 0) + COALESCE((
    SELECT SUM(t.amount)
    FROM transactions t
    WHERE t.account_id = a.id
      AND (t.status IS NULL OR t.status != 'VOID')
      AND t.parent_transaction_id IS NULL
), 0)
WHERE a.id IN (SELECT account_id FROM _rounded_cash_tx_accounts);

DROP TABLE _rounded_cash_tx_accounts;
