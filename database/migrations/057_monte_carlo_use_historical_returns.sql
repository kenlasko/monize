-- 057: Per-scenario flag to recompute return assumptions from holdings on each
-- run instead of using the saved expected_return / volatility values.

ALTER TABLE monte_carlo_scenarios
  ADD COLUMN IF NOT EXISTS use_historical_returns BOOLEAN NOT NULL DEFAULT FALSE;
