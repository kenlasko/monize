-- Bucket budget strategy, tables and membership column
-- (docs/future-plans/bucket-budget.md sections 6.1 to 6.3).
--
-- budget_buckets: the named pots one budget owns, each with a target that is
-- a percent of bucket income or a fixed amount per period, and an optional
-- carry-over of what is left at a period close (limited by carry_cap).
--
-- budget_categories.bucket_id: the bucket a non-income line belongs to.
-- Nullable; deleting a bucket unassigns its lines (ON DELETE SET NULL).
--
-- budget_period_buckets: one row per bucket per period. A period's creation
-- writes the carry it receives (carry_in); the close freezes the bucket's
-- figures. bucket_id is nulled when the bucket is deleted, and bucket_name
-- keeps the name the bucket had when the row was last written, so a closed
-- period still reads after the bucket is gone.
--
-- The 0..100 bound of a PERCENT target and the case-insensitive name rule are
-- the service's (they depend on target_type and on a fold the unique key does
-- not express); the CHECKs here hold only what no row may ever violate.
--
-- Both tables are owned through budgets.user_id: the indirect policies below
-- copy the budget_categories (one hop) and budget_period_categories (two hops)
-- shapes of 113_rls_policies_indirect.sql.
--
-- Expand only: two new tables and one nullable column. The previous release
-- neither reads nor writes any of them. Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS budget_buckets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    -- Stored trimmed.
    name VARCHAR(50) NOT NULL,
    target_type VARCHAR(10) NOT NULL,
    -- A percent (PERCENT) or an amount in the budget's currency per period
    -- (AMOUNT).
    target_value NUMERIC(24, 8) NOT NULL,
    carry_over BOOLEAN NOT NULL DEFAULT false,
    carry_cap NUMERIC(24, 8),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_budget_buckets_budget_name UNIQUE (budget_id, name),
    CONSTRAINT chk_budget_buckets_target_type
        CHECK (target_type IN ('PERCENT', 'AMOUNT')),
    CONSTRAINT chk_budget_buckets_target_value CHECK (target_value > 0),
    CONSTRAINT chk_budget_buckets_carry_cap
        CHECK (carry_cap IS NULL OR carry_cap > 0)
);

CREATE INDEX IF NOT EXISTS idx_budget_buckets_budget
    ON budget_buckets(budget_id);

DROP TRIGGER IF EXISTS update_budget_buckets_updated_at ON budget_buckets;
CREATE TRIGGER update_budget_buckets_updated_at
    BEFORE UPDATE ON budget_buckets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE budget_categories
    ADD COLUMN IF NOT EXISTS bucket_id UUID REFERENCES budget_buckets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_budget_categories_bucket
    ON budget_categories(bucket_id)
    WHERE bucket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS budget_period_buckets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_period_id UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
    bucket_id UUID REFERENCES budget_buckets(id) ON DELETE SET NULL,
    bucket_name VARCHAR(50) NOT NULL,
    target_type VARCHAR(10) NOT NULL,
    target_value NUMERIC(24, 8) NOT NULL,
    -- Bucket income at the close; null while open or when unknown.
    income_basis NUMERIC(24, 8),
    -- Null while open, and when the allocation is unknown at the close.
    allocated_amount NUMERIC(24, 8),
    carry_in NUMERIC(24, 8) NOT NULL DEFAULT 0,
    actual_amount NUMERIC(24, 8) NOT NULL DEFAULT 0,
    carry_out NUMERIC(24, 8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_budget_period_buckets_period_bucket
        UNIQUE (budget_period_id, bucket_id),
    CONSTRAINT chk_budget_period_buckets_target_type
        CHECK (target_type IN ('PERCENT', 'AMOUNT')),
    CONSTRAINT chk_budget_period_buckets_target_value CHECK (target_value > 0)
);

CREATE INDEX IF NOT EXISTS idx_budget_period_buckets_bucket
    ON budget_period_buckets(bucket_id)
    WHERE bucket_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_budget_period_buckets_updated_at ON budget_period_buckets;
CREATE TRIGGER update_budget_period_buckets_updated_at
    BEFORE UPDATE ON budget_period_buckets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE budget_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_period_buckets ENABLE ROW LEVEL SECURITY;

-- budget_buckets -> budgets.user_id
DROP POLICY IF EXISTS budget_buckets_isolation ON budget_buckets;
CREATE POLICY budget_buckets_isolation ON budget_buckets
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_buckets.budget_id
      AND b.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_buckets.budget_id
      AND b.user_id = (SELECT app_current_user_id())));

-- budget_period_buckets -> budget_periods -> budgets.user_id (two-hop)
DROP POLICY IF EXISTS budget_period_buckets_isolation ON budget_period_buckets;
CREATE POLICY budget_period_buckets_isolation ON budget_period_buckets
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budget_periods bp
    JOIN budgets b ON b.id = bp.budget_id
    WHERE bp.id = budget_period_buckets.budget_period_id
      AND b.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM budget_periods bp
    JOIN budgets b ON b.id = bp.budget_id
    WHERE bp.id = budget_period_buckets.budget_period_id
      AND b.user_id = (SELECT app_current_user_id())));
