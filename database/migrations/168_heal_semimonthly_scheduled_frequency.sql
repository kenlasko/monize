-- Mortgage accounts created with a SEMI_MONTHLY payment frequency wrote
-- "SEMI_MONTHLY" into scheduled_transactions.frequency, but the recurrence
-- engine's enum spells it "SEMIMONTHLY" (no underscore) and its switch has a
-- pass-through default: calculateNextDueDate returned the same date, so the
-- occurrence stayed due forever and the payment schedule never advanced.
-- LoanPaymentSetupService mapped it correctly; only the mortgage path did not.
--
-- The column is a bare VARCHAR(20) with no CHECK, so the wrong value persisted
-- silently. Heal the rows already written; the code fix stops new ones.
--
-- next_due_date is healed in the SAME statement, and that is the half that
-- matters more than the spelling. A frozen schedule stopped advancing on the day
-- it first posted: calculateNextDueDate returned the same date, the occurrence
-- claim in scheduled_transaction_postings refused every repeat, and next_due_date
-- has sat in the past ever since -- for a two-year-old mortgage, two years in the
-- past. Fixing only the frequency unfreezes it against that stale date, and the
-- auto-post cron posts occurrences where next_due_date <= today ONE PER RUN: a
-- back-dated installment a day, forty-eight of them, each moving the mortgage
-- balance, with nothing on screen to explain it.
--
-- So the schedule resumes from now: next_due_date moves to the first date the
-- recurrence engine's SEMIMONTHLY cadence actually reaches on or after today --
-- the 15th, or the last day of the month. The occurrences that never fired are
-- deliberately NOT posted. The borrower has been recording those payments some
-- other way or not at all, and either way that is a question about their history
-- to answer by hand; inventing forty-eight transactions to answer it is the one
-- outcome that cannot be undone. Rows still due in the future keep their date.
--
-- Idempotent for the same reason the frequency heal is: after this runs no row
-- matches SEMI_MONTHLY, so a second pass selects nothing and cannot move a date
-- twice.
UPDATE scheduled_transactions
SET frequency = 'SEMIMONTHLY',
    next_due_date = CASE
        WHEN next_due_date >= CURRENT_DATE THEN next_due_date
        -- The engine's cadence is the 15th and the last day of the month, so the
        -- first occurrence on or after today is one of those two.
        WHEN EXTRACT(DAY FROM CURRENT_DATE) <= 15
            THEN date_trunc('month', CURRENT_DATE)::date + 14
        ELSE (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date - 1
    END
WHERE frequency = 'SEMI_MONTHLY';
