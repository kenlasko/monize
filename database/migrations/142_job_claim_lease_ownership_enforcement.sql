-- 141: enforce lease ownership in the database, so a previous-release pod cannot
-- release or mark a lease that a new pod has retaken during a rolling deployment.
--
-- Migration 140 added `job_claims.lease_token`; the new `release()` and
-- `markDelivered()` filter on it, so a stalled new-code attempt whose lease was
-- retaken matches zero rows and writes nothing. That protects new code from new
-- code. It does not protect a new-code lease from the *previous* binary, whose
-- statements name the work and not the holder (audit V4R3-004):
--
--     DELETE FROM job_claims WHERE claim_type=$1 AND user_id=$2 AND claim_key=$3
--     UPDATE job_claims SET delivered_at=now(), expires_at=NULL WHERE <same key>
--
-- During a rollout: old pod A claims work and stalls past its lease; new pod B
-- retakes it and writes token B; A resumes and its old `release()` deletes B's live
-- row by work key, leaving the replica actually sending with no exclusion, or its
-- old `markDelivered()` stamps a delivery for a send B has not finished. The nullable
-- column cannot stop those statements, exactly as it could not for the MNY checkpoint
-- (migration 140 -> 141) or the attachment quarantine (143 -> 144). The rule lives
-- where both binaries meet: a session that mutates a *live tokenized* lease must own
-- it.
--
-- Ownership is proven by a transaction-local GUC, `app.job_claim_lease_token`, that
-- the new tokenized `release()` / `markDelivered()` set to their lease token before
-- the write. A BEFORE DELETE / BEFORE UPDATE trigger, firing only on a live lease
-- that carries a token, rejects the statement unless the session's GUC matches the
-- row's token. The previous binary never sets the GUC, so it can never mutate a
-- tokenized live lease held by new code.
--
-- What the WHEN clause deliberately excludes, so nothing legitimate is blocked:
--
--   * `claimLease` retaking an expired lease -- the row is expired, WHEN is false.
--   * a permanent `claimOnce` row -- `lease_token` is NULL, WHEN is false.
--   * the retention sweep -- it deletes rows older than 30 days, which are expired
--     or permanent, so `expires_at > now()` is false.
--   * a delivered row -- `markDelivered` sets `expires_at = NULL`, so WHEN is false.
--
-- The only writes reaching a live tokenized lease are the tokenized release/mark
-- themselves, which set the GUC, and the previous binary's untokenized ones, which
-- do not. Idempotent: CREATE OR REPLACE FUNCTION, triggers dropped first.

CREATE OR REPLACE FUNCTION guard_job_claim_lease_ownership()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    IF COALESCE(current_setting('app.job_claim_lease_token', true), '')
       IS DISTINCT FROM OLD.lease_token::text THEN
        RAISE EXCEPTION
          'job_claims lease % (%/%/%) is held by another attempt; this session does not own it',
          OLD.lease_token, OLD.claim_type, OLD.user_id, OLD.claim_key
          USING ERRCODE = 'raise_exception';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_claims_guard_delete ON job_claims;
CREATE TRIGGER trg_job_claims_guard_delete
    BEFORE DELETE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();

DROP TRIGGER IF EXISTS trg_job_claims_guard_update ON job_claims;
CREATE TRIGGER trg_job_claims_guard_update
    BEFORE UPDATE ON job_claims
    FOR EACH ROW
    WHEN (
      OLD.lease_token IS NOT NULL
      AND OLD.expires_at IS NOT NULL
      AND OLD.expires_at > CURRENT_TIMESTAMP
    )
    EXECUTE FUNCTION guard_job_claim_lease_ownership();
