-- 139: Database-enforced guards for the concurrency defects the Phase 4 audit
-- confirmed. Each one replaces an application-level check-then-act that two
-- replicas, two tabs or a retry could both pass.
--
-- Six independent guards, all idempotent:
--
--   1. job_claims          -- the one durable claim mechanism for per-user work
--                             that must happen at most once however many
--                             replicas fire the cron (P4-013, P4-014, P4-018).
--   2. import_jobs         -- a status CHECK and a partial unique index, so
--                             "one active import per user" is enforced by the
--                             database instead of by a count() before an insert
--                             (P4-001), plus a data_committed checkpoint that
--                             tells a retry whether the first run already wrote
--                             the ledger (P4-002).
--   3. scheduled_transaction_postings -- an occurrence key, so one due date
--                             posts one transaction (P4-004).
--   4. budget_alerts       -- a unique fingerprint matching the app's own
--                             de-duplication rule, so two alert processors
--                             cannot both insert the same alert and both email
--                             it (P4-015).
--   5. transaction_attachments -- an index supporting the parent-locked cap
--                             count (P4-017).
--   6. attachment_blob_tombstones -- a deletion record for bytes PostgreSQL
--                             cannot roll back, written by a trigger so the
--                             ON DELETE CASCADE path is covered too (P4-010).
--
-- Behaviour-neutral at RLS_MODE=off. All three new tables ship their policy AND
-- their own ENABLE, per the post-123 convention the T1 harness enforces.
--
-- Two of the guards are constraints over data that already exists, and both are
-- constraints against a state the old code could reach: more than one active
-- import per user, and duplicate budget alerts. A `CREATE UNIQUE INDEX` over a
-- table already in that state fails -- and a failed migration is not a failed
-- check, because `db-migrate` runs at container start, so the backend never
-- boots and the deploy reports only "backend exited (1)". Each of those two
-- guards is therefore preceded by a documented repair phase that says exactly
-- which row survives and what happens to the rest. Both repairs are
-- re-runnable: after the first pass their queries select nothing.
-- `backend/test/integration/migration-139-preflight.integration.spec.ts` seeds
-- the legacy states and asserts the migration completes and repairs them.

-- ---------------------------------------------------------------------------
-- 1. job_claims
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_type VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_key VARCHAR(200) NOT NULL,
    claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL means a permanent claim (a delivery); a timestamp means a lease that
    -- a later worker may retake once it has passed.
    expires_at TIMESTAMP
);

-- The whole point of the table: the claim is one atomic statement, so there is
-- no window between a replica deciding to send and recording that it did.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_claims_key
    ON job_claims(claim_type, user_id, claim_key);

CREATE INDEX IF NOT EXISTS idx_job_claims_claimed_at ON job_claims(claimed_at);

ALTER TABLE job_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_claims_isolation ON job_claims;
CREATE POLICY job_claims_isolation ON job_claims
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- 2. import_jobs: status CHECK, active-job uniqueness, commit checkpoint
-- ---------------------------------------------------------------------------

-- Set inside the import transaction itself, so it commits with the rows it
-- describes. That is what makes the difference between "the run failed before
-- writing anything, retry is free" and "the ledger is already written and only
-- the completion metadata is missing" -- states the old retryable flag folded
-- into one and offered as an ordinary retry.
--
-- Added before the repair below, which reads it to decide whether a superseded
-- job may be offered as a retry.
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS data_committed BOOLEAN NOT NULL DEFAULT false;

-- PREFLIGHT (1 of 2): statuses the new CHECK would refuse.
--
-- A constraint added to a populated table validates every existing row, so a
-- status outside the four the application writes -- a hand-edited row, a value
-- from a version of the code that predates this vocabulary -- aborts the
-- migration. And an aborted migration is not a failed check: `db-migrate` runs
-- at container start, so the backend never comes up and the deploy reports only
-- "backend exited (1)". Normalize first, then constrain.
--
-- 'failed' is the honest landing place: the row describes a run nobody is
-- driving, and it is not retryable if its data is already in the ledger.
UPDATE import_jobs
   SET status = 'failed',
       error_key = CASE WHEN data_committed THEN 'mnyJobStalledAfterCommit'
                        ELSE 'mnyJobStalled' END,
       error_detail = 'Import job carried a status this version does not recognize',
       retryable = (data_committed = false),
       progress = NULL,
       completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
 WHERE status IS NULL
    OR status NOT IN ('pending', 'running', 'completed', 'failed');

-- The CHECK is load-bearing for the partial index below, not cosmetic: the
-- index's predicate names two statuses, so a typo'd status written by
-- application code would sit outside the predicate and let a second active job
-- exist while still looking active to hasActiveJob().
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed'));

-- PREFLIGHT (2 of 2): the duplicates the new unique index would refuse.
--
-- "More than one active import for one user" is precisely the state this index
-- exists to prevent, so any database that ran the racy `hasActiveJob()` check
-- can already be in it -- and `CREATE UNIQUE INDEX` on a table that is already
-- in it fails. The guard cannot be introduced without saying what happens to
-- the rows that predate it.
--
-- Keep exactly one job per user and fail the rest. The one kept is the one most
-- likely to be real work, in this order:
--
--   1. `data_committed` -- a job that has written to the ledger is the one whose
--      completion path still matters; never discard it in favour of a pristine
--      duplicate.
--   2. 'running' over 'pending' -- a worker picked it up.
--   3. the most recent heartbeat -- among running jobs, the live one.
--   4. the newest -- an arbitrary but stable tie-break.
--
-- The losers are failed with the same keys the stale-job reaper uses, so the UI
-- copy and the Retry gating are already right: `mnyJobStalledAfterCommit` and
-- `retryable = false` for a job whose data is in, `mnyJobStalled` and a genuine
-- retry for one whose is not. Those two literals are owned by
-- `backend/src/import/mny/mny-import-job.service.ts`
-- (`JOB_STALLED_ERROR_KEY` / `JOB_COMMITTED_STALLED_ERROR_KEY`); a rename there
-- has to change them here.
--
-- Re-runnable: after the first pass no user has two active jobs, so the CTE
-- returns nothing.
WITH superseded AS (
    SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id
                 ORDER BY data_committed DESC,
                          (status = 'running') DESC,
                          heartbeat_at DESC NULLS LAST,
                          created_at DESC NULLS LAST,
                          id DESC
               ) AS rn
          FROM import_jobs
         WHERE status IN ('pending', 'running')
      ) ranked
     WHERE rn > 1
)
UPDATE import_jobs j
   SET status = 'failed',
       error_key = CASE WHEN j.data_committed THEN 'mnyJobStalledAfterCommit'
                        ELSE 'mnyJobStalled' END,
       error_detail = 'Superseded: this account had more than one import running before the database enforced one at a time',
       retryable = (j.data_committed = false),
       progress = NULL,
       completed_at = CURRENT_TIMESTAMP
  FROM superseded s
 WHERE s.id = j.id;

-- One active import per user, enforced where it cannot be raced. The intended
-- key at this baseline is the user: hasActiveJob() asks only whether that user
-- has any pending/running job, the 409 says "an import is already running", and
-- the product deliberately blocks a second file as well as the same one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_jobs_one_active_per_user
    ON import_jobs(user_id)
    WHERE status IN ('pending', 'running');

-- ---------------------------------------------------------------------------
-- 3. scheduled_transaction_postings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scheduled_transaction_postings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_transaction_id UUID NOT NULL
        REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    -- The occurrence's identity: the schedule's next_due_date at posting time.
    -- Not posted_date, which an override or an inline transactionDate moves.
    original_due_date DATE NOT NULL,
    posted_date DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stp_occurrence
    ON scheduled_transaction_postings(scheduled_transaction_id, original_due_date);

ALTER TABLE scheduled_transaction_postings ENABLE ROW LEVEL SECURITY;

-- Indirect ownership: the postings table has no user_id of its own, so it
-- inherits the schedule's, exactly like scheduled_transaction_overrides.
DROP POLICY IF EXISTS scheduled_transaction_postings_isolation ON scheduled_transaction_postings;
CREATE POLICY scheduled_transaction_postings_isolation ON scheduled_transaction_postings
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_postings.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM scheduled_transactions st
    WHERE st.id = scheduled_transaction_postings.scheduled_transaction_id
      AND st.user_id = (SELECT app_current_user_id())));

-- ---------------------------------------------------------------------------
-- 4. budget_alerts: the app's de-duplication rule as a database key
-- ---------------------------------------------------------------------------

-- PREFLIGHT: the duplicates the fingerprint would refuse.
--
-- `deduplicateAlerts()` ran in application code with no key under it, which is
-- the whole finding (P4-015) -- so on any database that has had two alert
-- processors overlap, the duplicate rows are already there and the unique index
-- cannot be created over them.
--
-- Alerts are notifications, so collapsing a duplicate set to one row loses
-- nothing except the duplicate. What must survive is anything the user did with
-- it: keep the row that was dismissed, then the one that was read, then the one
-- whose email went out, then the oldest -- the one they actually saw.
-- Deleting the others cannot orphan anything: no table references
-- `budget_alerts`.
--
-- Re-runnable: after the first pass no fingerprint has two rows.
DELETE FROM budget_alerts
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY budget_id,
                             period_start,
                             alert_type,
                             COALESCE(budget_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
                             severity
                ORDER BY (dismissed_at IS NOT NULL) DESC,
                         COALESCE(is_read, false) DESC,
                         COALESCE(is_email_sent, false) DESC,
                         created_at ASC NULLS LAST,
                         id ASC
              ) AS rn
         FROM budget_alerts
     ) ranked
    WHERE rn > 1
 );

-- deduplicateAlerts() drops a candidate matching an existing (alert_type,
-- budget_category_id) unless its severity is strictly higher -- so severity
-- belongs in the key, and an escalation is still allowed to insert. COALESCE
-- because a budget-wide alert has a NULL category, and NULL never equals NULL
-- in a unique index: without it the budget-wide alerts -- flex group, income
-- shortfall, positive milestone -- would be exactly the ones left unguarded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_fingerprint
    ON budget_alerts(
        budget_id,
        period_start,
        alert_type,
        COALESCE(budget_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
        severity
    );

-- ---------------------------------------------------------------------------
-- 5. transaction_attachments
-- ---------------------------------------------------------------------------

-- The per-transaction cap is now counted under a lock on the parent transaction
-- row; this index keeps that count from being a sequential scan.
CREATE INDEX IF NOT EXISTS idx_transaction_attachments_transaction
    ON transaction_attachments(transaction_id);

-- ---------------------------------------------------------------------------
-- 6. attachment_blob_tombstones -- external bytes get a deletion record
-- ---------------------------------------------------------------------------
--
-- Local-filesystem and S3 attachment bytes cannot be rolled back with
-- PostgreSQL, and deleting them *before* the metadata delete commits meant a
-- rollback left metadata pointing at bytes that were already gone. Worse,
-- deleting a transaction removes its attachment metadata by ON DELETE CASCADE
-- with no application code running at all, so those objects were never deleted
-- and accumulated unbounded (audit P4-010).
--
-- A tombstone written by a trigger covers every deletion path -- API delete,
-- parent-transaction cascade, restore wipe, account deletion -- because it is
-- the database that knows a row went away. The sweeper then deletes the object
-- and drops the tombstone, so a crash between the two costs a retry rather than
-- an orphan nobody can find.
--
-- user_id is ON DELETE SET NULL, not CASCADE: deleting a user is exactly when
-- their bytes most need removing, so the tombstone must outlive them.
CREATE TABLE IF NOT EXISTS attachment_blob_tombstones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    storage_provider VARCHAR(20) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- Unique, so a tombstone is idempotent: two records for one object describe the
-- same pending deletion, and the trigger can therefore be a plain
-- ON CONFLICT DO NOTHING insert with no bookkeeping of its own.
CREATE UNIQUE INDEX IF NOT EXISTS idx_abt_object
    ON attachment_blob_tombstones(storage_provider, storage_key);
CREATE INDEX IF NOT EXISTS idx_abt_deleted_at ON attachment_blob_tombstones(deleted_at);

ALTER TABLE attachment_blob_tombstones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attachment_blob_tombstones_isolation ON attachment_blob_tombstones;
CREATE POLICY attachment_blob_tombstones_isolation ON attachment_blob_tombstones
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- SECURITY DEFINER so the tombstone is written as the table owner.
--
-- Under RLS the trigger would otherwise insert as the invoking role and be
-- refused whenever the deleted row's owner is not the session's identity -- a
-- cross-owner transfer counterpart, an admin path -- and a refused trigger
-- fails the DELETE itself. Losing the audit record must never be able to block
-- the delete, and neither must the delete be able to skip the record.
-- search_path is pinned: a SECURITY DEFINER function that resolves its tables
-- through the caller's search_path is a privilege-escalation hole.
CREATE OR REPLACE FUNCTION record_attachment_blob_tombstone() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO attachment_blob_tombstones (user_id, storage_provider, storage_key)
    VALUES (OLD.user_id, OLD.storage_provider, OLD.storage_key)
    ON CONFLICT (storage_provider, storage_key) DO NOTHING;
    RETURN OLD;
END;
$$;

-- Only for providers whose bytes live outside PostgreSQL. The database provider
-- keeps them in `attachment_blobs`, whose own foreign key cascades -- a
-- tombstone there would describe work already done.
DROP TRIGGER IF EXISTS trg_attachment_blob_tombstone ON transaction_attachments;
CREATE TRIGGER trg_attachment_blob_tombstone
    AFTER DELETE ON transaction_attachments
    FOR EACH ROW
    WHEN (OLD.storage_provider <> 'database')
    EXECUTE FUNCTION record_attachment_blob_tombstone();
