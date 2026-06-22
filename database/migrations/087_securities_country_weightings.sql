-- Adds a manual country allocation breakdown to securities. Yahoo/MSN do not
-- provide country exposure for ETFs/funds, so users (or an AI assistant) enter
-- it by hand. Stored exactly like sector_weightings: an array of
-- [{name, weight}] where weight is a decimal 0-1. Any shortfall under 1.0 is
-- treated as "Other" at display/report time and is not stored.

ALTER TABLE securities ADD COLUMN IF NOT EXISTS country_weightings JSONB;
