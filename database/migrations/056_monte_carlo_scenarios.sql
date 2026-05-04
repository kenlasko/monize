-- 056: Monte Carlo retirement-projection scenarios.
--
-- Saves user-configured simulation inputs (selected accounts, contribution
-- and withdrawal schedules, return assumptions, inflation, etc.) so the user
-- can re-open and re-run a scenario later. Per-run results are not persisted;
-- they're recomputed on demand.

CREATE TABLE IF NOT EXISTS monte_carlo_scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    account_ids UUID[] NOT NULL DEFAULT '{}',
    starting_value NUMERIC(20, 4) NOT NULL DEFAULT 0,
    use_current_balance BOOLEAN NOT NULL DEFAULT TRUE,

    years_to_retirement INTEGER NOT NULL,
    annual_contribution NUMERIC(20, 4) NOT NULL DEFAULT 0,
    contribution_growth_rate NUMERIC(8, 6) NOT NULL DEFAULT 0,

    years_in_retirement INTEGER NOT NULL DEFAULT 0,
    annual_withdrawal NUMERIC(20, 4) NOT NULL DEFAULT 0,

    expected_return NUMERIC(8, 6) NOT NULL,
    volatility NUMERIC(8, 6) NOT NULL,

    inflation_rate NUMERIC(8, 6) NOT NULL DEFAULT 0.025,
    show_real_values BOOLEAN NOT NULL DEFAULT FALSE,

    simulation_count INTEGER NOT NULL DEFAULT 5000,
    target_value NUMERIC(20, 4),
    random_seed BIGINT,

    is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
    last_run_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT monte_carlo_scenarios_years_to_retirement_check
      CHECK (years_to_retirement BETWEEN 0 AND 100),
    CONSTRAINT monte_carlo_scenarios_years_in_retirement_check
      CHECK (years_in_retirement BETWEEN 0 AND 100),
    CONSTRAINT monte_carlo_scenarios_simulation_count_check
      CHECK (simulation_count BETWEEN 100 AND 50000),
    CONSTRAINT monte_carlo_scenarios_volatility_check
      CHECK (volatility >= 0)
);

CREATE INDEX IF NOT EXISTS idx_monte_carlo_scenarios_user
  ON monte_carlo_scenarios(user_id);

CREATE TRIGGER update_monte_carlo_scenarios_updated_at
  BEFORE UPDATE ON monte_carlo_scenarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
