-- Migration: Add Budget Planner Tables
-- Date: 2026-02-19

-- Budgets - core budget definition
CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    budget_type VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    period_start DATE NOT NULL,
    period_end DATE,
    base_income NUMERIC(20, 4),
    income_linked BOOLEAN DEFAULT false,
    strategy VARCHAR(30) NOT NULL DEFAULT 'FIXED',
    is_active BOOLEAN DEFAULT true,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE budgets OWNER TO monize;

CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_active ON budgets(user_id, is_active);

-- Budget Categories - per-category budget allocation
CREATE TABLE IF NOT EXISTS budget_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    transfer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    is_transfer BOOLEAN DEFAULT false,
    category_group VARCHAR(20),
    amount NUMERIC(20, 4) NOT NULL,
    is_income BOOLEAN DEFAULT false,
    rollover_type VARCHAR(20) DEFAULT 'NONE',
    rollover_cap NUMERIC(20, 4),
    flex_group VARCHAR(100),
    alert_warn_percent INTEGER DEFAULT 80,
    alert_critical_percent INTEGER DEFAULT 95,
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE budget_categories OWNER TO monize;

CREATE INDEX IF NOT EXISTS idx_budget_categories_budget ON budget_categories(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_categories_category ON budget_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_budget_categories_flex ON budget_categories(budget_id, flex_group)
    WHERE flex_group IS NOT NULL;

-- Budget Periods - snapshot of each completed period
CREATE TABLE IF NOT EXISTS budget_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    actual_income NUMERIC(20, 4) DEFAULT 0,
    actual_expenses NUMERIC(20, 4) DEFAULT 0,
    total_budgeted NUMERIC(20, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_budget_periods_budget ON budget_periods(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_periods_dates ON budget_periods(budget_id, period_start, period_end);

-- Budget Period Categories - per-category actuals for each period
CREATE TABLE IF NOT EXISTS budget_period_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_period_id UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    budget_category_id UUID NOT NULL REFERENCES budget_categories(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    budgeted_amount NUMERIC(20, 4) NOT NULL,
    rollover_in NUMERIC(20, 4) DEFAULT 0,
    actual_amount NUMERIC(20, 4) DEFAULT 0,
    effective_budget NUMERIC(20, 4) NOT NULL,
    rollover_out NUMERIC(20, 4) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(budget_period_id, budget_category_id)
);

ALTER TABLE budget_period_categories OWNER TO monize;

CREATE INDEX IF NOT EXISTS idx_bpc_period ON budget_period_categories(budget_period_id);
CREATE INDEX IF NOT EXISTS idx_bpc_category ON budget_period_categories(category_id);

-- Budget Alerts - persistent alert records
CREATE TABLE IF NOT EXISTS budget_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    budget_category_id UUID REFERENCES budget_categories(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    is_read BOOLEAN DEFAULT false,
    is_email_sent BOOLEAN DEFAULT false,
    period_start DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE budget_alerts OWNER TO monize;

CREATE INDEX IF NOT EXISTS idx_budget_alerts_user ON budget_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_user_unread ON budget_alerts(user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_budget_alerts_budget_period ON budget_alerts(budget_id, period_start);

-- Triggers for budget tables updated_at
CREATE TRIGGER update_budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_categories_updated_at BEFORE UPDATE ON budget_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_periods_updated_at BEFORE UPDATE ON budget_periods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_budget_period_categories_updated_at BEFORE UPDATE ON budget_period_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
