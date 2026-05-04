-- 059: Track total-return adjusted close (split + dividend adjusted) on
-- security_prices. Populated alongside the raw close on ingestion. Used by
-- Monte Carlo's historical-stats calculation so mean return reflects total
-- return (price + dividends), not just price appreciation.

ALTER TABLE security_prices
  ADD COLUMN IF NOT EXISTS adjusted_close NUMERIC(20, 6);
