-- Caps currencies.decimal_places at 8, the scale an account-currency amount is
-- stored at (NUMERIC(24,8), 20261106012628_money_scale_8.sql): a currency
-- cannot carry more places than an amount is stored at (docs/specs/money-precision.md,
-- decision 2). The DTO (@Max(8)) and the backup restore's clamp (0..8) hold
-- the same range; this is the backstop for any other writer.
--
-- Every existing row satisfies it: the DTO has capped decimal_places at 4, the
-- restore clamped it to 0..4, and the seeded currencies carry 0 to 3. NULL
-- (the column has a default but no NOT NULL) passes a CHECK, as before.
--
-- Rolling deployment: the 1.20.0 release writes 0..4 only, inside the new
-- range, so it is unaffected.
--
-- Idempotent: the constraint is dropped before it is added.
ALTER TABLE currencies DROP CONSTRAINT IF EXISTS currencies_decimal_places_check;
ALTER TABLE currencies ADD CONSTRAINT currencies_decimal_places_check
    CHECK (decimal_places BETWEEN 0 AND 8);
