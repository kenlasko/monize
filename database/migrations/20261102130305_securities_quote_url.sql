-- Add securities.quote_url: the web page whose price table the html_table quote
-- provider reads for that security. Nullable, no default; ignored by every other
-- provider.

ALTER TABLE securities ADD COLUMN IF NOT EXISTS quote_url VARCHAR(2048);
