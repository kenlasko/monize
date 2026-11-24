-- Record when a provider refresh last wrote each security price (issue #2385).
--
-- The Investments page's "Refresh (x ago)" reads GET /securities/prices/status,
-- which answered from created_at. A refresh during the session UPDATEs the
-- day's row in place (ON CONFLICT (security_id, price_date) DO UPDATE), so
-- created_at stays at whenever today's row was first inserted: after a page
-- load the button said "6 hours ago" while the 15-minute automatic refresh had
-- written a minute earlier. quoted_at is the instant the provider struck the
-- quote, not when we fetched it, so it does not answer the question either.
--
-- refreshed_at is stamped by every provider write, insert and update alike.
-- NULL for manual entries, rows derived from transactions, and every row
-- written before this column existed; the status endpoint falls back to
-- created_at for those.

ALTER TABLE security_prices
  ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMPTZ;

COMMENT ON COLUMN security_prices.refreshed_at IS
  'Instant a provider refresh last wrote this row (insert or same-day update). NULL for manual entries, rows derived from transactions, and every row written before this column existed.';
