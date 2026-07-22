-- 'LOWER_INSTALLMENT' is 17 characters, but recurring_extra_mode was created
-- as VARCHAR(16) (migration 098), so saving a scenario whose recurring
-- overpayment uses the lower-installment mode failed with "value too long for
-- type character varying(16)" (22001). Widen to 64.
-- Safe on any database: widening a varchar never touches stored data, and
-- re-running is a no-op in effect.
-- (Numbered 105: 103/104 are reserved by the in-flight monthly-budget branch.)
ALTER TABLE loan_scenarios
    ALTER COLUMN recurring_extra_mode TYPE VARCHAR(64);
