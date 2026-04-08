-- Add exchange_rate to investment_transactions so cross-currency purchases
-- (e.g. USD security inside a CAD investment account) can convert the cost
-- into the cash account's currency when posting to the linked cash account.
ALTER TABLE investment_transactions
    ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 10) NOT NULL DEFAULT 1;
