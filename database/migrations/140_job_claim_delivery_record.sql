-- 139: a job claim can now record that its delivery actually happened.
--
-- Migration 139 gave the multi-replica reminders a durable claim, which stopped
-- two replicas emailing the same user twice. It did not make a claimed-but-unsent
-- reminder recoverable, because `claimOnce` is taken *before* the send and is the
-- only record that the send was owed (audit RV4-006).
--
-- A replica that commits the claim and is then killed -- an OOM, a rolling
-- restart, a pod eviction -- leaves a permanent row that every other replica and
-- every later run reads as "already handled". The bill-payment or mortgage-renewal
-- email is simply never sent, and nothing can notice, because the row cannot tell
-- "I sent this" from "I intended to".
--
-- Those are two different facts and they need two different columns:
--
--   expires_at   -- the lease. Present while a replica is doing the work, gone or
--                   past when it is not. Bounded, so a killed replica costs a
--                   retry window rather than the delivery.
--   delivered_at -- the delivery. Written *after* the side effect succeeded, and
--                   re-read under the lease to decide whether the work is still
--                   owed. A delivered row is never retaken.
--
-- The resulting contract is **at-least-once**: a process killed between SMTP
-- acceptance and `delivered_at` re-sends on the next run. For a reminder that is
-- the right trade -- a duplicate nudge is a minor annoyance, a missed mortgage
-- renewal is not -- and it is a deliberate choice rather than a gap, so it is
-- written down in `docs/cron-jobs.md` next to the jobs that make it.
--
-- Backfill: every existing row is a `claimOnce` row, whose whole meaning was
-- "this window is spent". Treating those as delivered is the only reading that
-- preserves today's behaviour -- leaving them NULL would re-send every reminder
-- claimed before the upgrade. `claimed_at` is the honest timestamp for when that
-- decision was made.
--
-- What that backfill *also* preserves, and the decision taken about it
-- (DR-RRV4-02): a reminder lost in the old claim-before-send crash window is
-- indistinguishable from one delivered, because the old row recorded only the
-- intent. Marking these delivered therefore keeps any such loss lost. The state is
-- genuinely ambiguous and no predicate over these columns can resolve it without
-- provider evidence, so the choice is between one possible duplicate per affected
-- claim and one possible missed notice.
--
-- **Accepted deliberately, in this direction, once.** The alternative -- scoping the
-- backfill by claim type or date so recent windows re-send -- trades a silent miss
-- for a duplicate on every claim it covers, including the overwhelming majority that
-- were delivered correctly. These are daily reminders: a duplicate is noise a user
-- will forgive and a miss is a single day's notice, so neither outcome is severe,
-- and the tie is broken in favour of not emailing a population of users about bills
-- they were already told about. Every claim written *after* this migration keeps a
-- real delivery record, so the ambiguity is bounded to rows that predate it and does
-- not recur.

ALTER TABLE job_claims
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- A permanent claim (`expires_at IS NULL`) is what the old `claimOnce` wrote, and
-- it meant the window was consumed. Preserve that reading rather than re-sending.
UPDATE job_claims
   SET delivered_at = claimed_at
 WHERE delivered_at IS NULL
   AND expires_at IS NULL;
