-- 058: Per-scenario cash-flow events (one-time or recurring) layered on top
-- of the base contribution/withdrawal phases. Used for things like
-- renovations, pension income, college costs, etc.
--
-- start_year / end_year are offsets from "today" (year 1 = next year).

CREATE TABLE IF NOT EXISTS monte_carlo_cash_flows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scenario_id UUID NOT NULL REFERENCES monte_carlo_scenarios(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    amount NUMERIC(20, 4) NOT NULL,
    flow_type VARCHAR(20) NOT NULL,
    start_year INTEGER NOT NULL,
    end_year INTEGER,
    inflation_adjust BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT mc_cash_flows_type_check
      CHECK (flow_type IN ('ONE_TIME', 'RECURRING')),
    CONSTRAINT mc_cash_flows_start_year_check
      CHECK (start_year BETWEEN 1 AND 100),
    CONSTRAINT mc_cash_flows_end_year_check
      CHECK (end_year IS NULL OR end_year BETWEEN start_year AND 100)
);

CREATE INDEX IF NOT EXISTS idx_monte_carlo_cash_flows_scenario
  ON monte_carlo_cash_flows(scenario_id);
