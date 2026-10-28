-- Read-only accrual facts follow the source transaction's existing RLS visibility.
-- Owner-only ALL/WITH CHECK policies remain in force for every write. A revoked
-- account grant removes recognition facts on the next read, without a cache.
ALTER TABLE accrual_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accrual_schedules_source_read ON accrual_schedules;
CREATE POLICY accrual_schedules_source_read ON accrual_schedules FOR SELECT
  USING ((SELECT app_bypass_rls()) OR EXISTS (SELECT 1 FROM transactions t
    WHERE t.id=accrual_schedules.source_transaction_id AND t.user_id=accrual_schedules.user_id));

ALTER TABLE accrual_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accrual_allocations_source_read ON accrual_allocations;
CREATE POLICY accrual_allocations_source_read ON accrual_allocations FOR SELECT
  USING ((SELECT app_bypass_rls()) OR EXISTS (SELECT 1 FROM accrual_schedules s
    WHERE s.id=accrual_allocations.schedule_id AND s.user_id=accrual_allocations.user_id));

ALTER TABLE accrual_system_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accrual_system_accounts_source_read ON accrual_system_accounts;
CREATE POLICY accrual_system_accounts_source_read ON accrual_system_accounts FOR SELECT
  USING ((SELECT app_bypass_rls()) OR EXISTS (SELECT 1 FROM accrual_schedules s
    WHERE s.user_id=accrual_system_accounts.user_id AND s.family=accrual_system_accounts.family
      AND s.currency_code=accrual_system_accounts.currency_code));
