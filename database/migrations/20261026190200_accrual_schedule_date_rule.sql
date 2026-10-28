-- First-business-day recognition dates for accrual schedules (monize-pr
-- PR prep, WMP's scheduling request in discussion #1797). Scoped to accrual
-- recognition only -- the shared recurrence engine behind issue #1857 is
-- untouched.
--
-- Month-end stays the default and needs no change: it is already computed
-- fresh from the calendar each period, never stepped from a prior date, so
-- it never drifts the way #1857 describes.

ALTER TABLE accrual_schedules
  ADD COLUMN IF NOT EXISTS recognition_date_rule VARCHAR(20) NOT NULL DEFAULT 'MONTH_END';
ALTER TABLE accrual_schedules
  DROP CONSTRAINT IF EXISTS ck_accrual_schedule_date_rule;
ALTER TABLE accrual_schedules
  ADD CONSTRAINT ck_accrual_schedule_date_rule
    CHECK (recognition_date_rule IN ('MONTH_END', 'FIRST_BUSINESS_DAY'));

-- Recognition dates must still land in their own month, but may now be
-- either the last calendar day (existing rule) or the first business day:
-- day 1 when it is Mon-Fri, otherwise the following Monday (day 2 or 3).
ALTER TABLE accrual_allocations
  DROP CONSTRAINT IF EXISTS ck_accrual_allocation_date;
ALTER TABLE accrual_allocations
  ADD CONSTRAINT ck_accrual_allocation_date CHECK (
    recognition_date >= DATE '0001-01-01' AND recognition_date <= DATE '9999-12-31' AND (
      recognition_date = (date_trunc('month', recognition_date::timestamp) + INTERVAL '1 month - 1 day')::date
      OR (
        (EXTRACT(DAY FROM recognition_date) = 1 AND EXTRACT(ISODOW FROM recognition_date) BETWEEN 1 AND 5)
        OR (EXTRACT(DAY FROM recognition_date) IN (2, 3) AND EXTRACT(ISODOW FROM recognition_date) = 1)
      )
    )
  );
