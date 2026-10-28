-- Master visibility switch for the accrual feature.
--
-- The maintainer wants accrual accounting entirely invisible -- no Accrual
-- tab, no Accounts/Other accrual balances, no Cash/Accrual report switch --
-- until a user explicitly turns it on in Settings. Default false, so every
-- existing and new user who has never asked for it sees none of it.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS accrual_enabled BOOLEAN NOT NULL DEFAULT false;
