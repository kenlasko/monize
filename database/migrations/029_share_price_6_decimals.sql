-- Increase share price precision from 4 to 6 decimal places
-- Affects: security_prices (OHLC), investment_transactions (price), holdings (average_cost)

ALTER TABLE security_prices
    ALTER COLUMN open_price TYPE NUMERIC(20, 6),
    ALTER COLUMN high_price TYPE NUMERIC(20, 6),
    ALTER COLUMN low_price TYPE NUMERIC(20, 6),
    ALTER COLUMN close_price TYPE NUMERIC(20, 6);

ALTER TABLE holdings
    ALTER COLUMN average_cost TYPE NUMERIC(20, 6);

ALTER TABLE investment_transactions
    ALTER COLUMN price TYPE NUMERIC(20, 6);
