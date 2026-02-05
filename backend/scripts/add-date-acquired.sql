-- Migration: Add date_acquired field for asset accounts
-- Description: Tracks when an asset was acquired so net worth reports exclude it before that date

ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS date_acquired DATE;
