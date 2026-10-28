-- Add owner-scoped accrual schedules and derived timing-account identities.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_transaction_owner ON transactions(id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_split_parent ON transaction_splits(id, transaction_id);

CREATE TABLE IF NOT EXISTS accrual_system_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family VARCHAR(10) NOT NULL,
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_accrual_system_identity UNIQUE (user_id, family, currency_code),
    CONSTRAINT ck_accrual_system_family CHECK (family IN ('expense', 'income'))
);
CREATE TABLE IF NOT EXISTS accrual_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_transaction_id UUID NOT NULL,
    source_split_id UUID,
    family VARCHAR(10) NOT NULL,
    currency_code VARCHAR(3) NOT NULL,
    preset VARCHAR(10) NOT NULL,
    start_month DATE NOT NULL,
    month_count INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    source_fingerprint CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_accrual_schedule_owner UNIQUE (id, user_id),
    CONSTRAINT fk_accrual_schedule_source FOREIGN KEY (source_transaction_id, user_id) REFERENCES transactions(id, user_id) ON DELETE CASCADE,
    CONSTRAINT fk_accrual_schedule_split FOREIGN KEY (source_split_id, source_transaction_id) REFERENCES transaction_splits(id, transaction_id) ON DELETE CASCADE,
    CONSTRAINT fk_accrual_schedule_system FOREIGN KEY (user_id, family, currency_code) REFERENCES accrual_system_accounts(user_id, family, currency_code),
    CONSTRAINT ck_accrual_schedule_count CHECK (month_count BETWEEN 1 AND 600),
    CONSTRAINT ck_accrual_schedule_start CHECK (EXTRACT(DAY FROM start_month) = 1 AND start_month >= DATE '0001-01-01' AND start_month <= DATE '9999-12-01'),
    CONSTRAINT ck_accrual_schedule_end CHECK (start_month + (month_count - 1) * INTERVAL '1 month' <= DATE '9999-12-01'),
    CONSTRAINT ck_accrual_schedule_preset CHECK (preset IN ('LTM', 'NTM', 'CUSTOM')),
    CONSTRAINT ck_accrual_schedule_revision CHECK (revision > 0),
    CONSTRAINT ck_accrual_schedule_fingerprint CHECK (source_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_schedule_transaction ON accrual_schedules(source_transaction_id) WHERE source_split_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_schedule_split ON accrual_schedules(source_split_id) WHERE source_split_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accrual_schedule_user ON accrual_schedules(user_id);

CREATE TABLE IF NOT EXISTS accrual_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    schedule_id UUID NOT NULL,
    period_index INTEGER NOT NULL,
    recognition_date DATE NOT NULL,
    amount NUMERIC(20,4) NOT NULL,
    CONSTRAINT fk_accrual_allocation_owner FOREIGN KEY (schedule_id, user_id) REFERENCES accrual_schedules(id, user_id) ON DELETE CASCADE,
    CONSTRAINT uq_accrual_allocation_period UNIQUE (schedule_id, period_index),
    CONSTRAINT ck_accrual_allocation_period CHECK (period_index BETWEEN 0 AND 599),
    CONSTRAINT ck_accrual_allocation_date CHECK (recognition_date >= DATE '0001-01-01' AND recognition_date <= DATE '9999-12-31' AND recognition_date = (date_trunc('month', recognition_date::timestamp) + INTERVAL '1 month - 1 day')::date)
);
CREATE INDEX IF NOT EXISTS idx_accrual_allocation_user_date ON accrual_allocations(user_id, recognition_date);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS reporting_basis VARCHAR(10) NOT NULL DEFAULT 'accrual';
ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS ck_user_preferences_reporting_basis;
ALTER TABLE user_preferences ADD CONSTRAINT ck_user_preferences_reporting_basis CHECK (reporting_basis IN ('cash', 'accrual'));

DROP POLICY IF EXISTS accrual_system_accounts_isolation ON accrual_system_accounts;
CREATE POLICY accrual_system_accounts_isolation ON accrual_system_accounts
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
ALTER TABLE accrual_system_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accrual_schedules_isolation ON accrual_schedules;
CREATE POLICY accrual_schedules_isolation ON accrual_schedules
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
ALTER TABLE accrual_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accrual_allocations_isolation ON accrual_allocations;
CREATE POLICY accrual_allocations_isolation ON accrual_allocations
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
ALTER TABLE accrual_allocations ENABLE ROW LEVEL SECURITY;
