-- A recipient explicitly accepts a particular ownership request before the owner completes it.
-- Consent is self-written, request-scoped, and not carried into detached backups.
ALTER TABLE shared_groups ADD COLUMN IF NOT EXISTS ownership_request_id UUID;
ALTER TABLE shared_groups ADD COLUMN IF NOT EXISTS ownership_candidate_id UUID;
ALTER TABLE shared_memberships ADD COLUMN IF NOT EXISTS ownership_accepted_request_id UUID;
ALTER TABLE shared_groups DROP CONSTRAINT IF EXISTS shared_groups_ownership_pair;
ALTER TABLE shared_groups ADD CONSTRAINT shared_groups_ownership_pair CHECK ((ownership_request_id IS NULL) = (ownership_candidate_id IS NULL));
ALTER TABLE shared_groups DROP CONSTRAINT IF EXISTS shared_groups_ownership_candidate_fk;
ALTER TABLE shared_groups ADD CONSTRAINT shared_groups_ownership_candidate_fk FOREIGN KEY (ownership_candidate_id) REFERENCES shared_participants(id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION shared_protect_membership() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_bypass_rls() AND app_current_user_id() IS NOT NULL THEN
    IF NEW.ownership_accepted_request_id IS DISTINCT FROM OLD.ownership_accepted_request_id
      AND app_current_user_id() IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Only the recipient may accept an ownership request' USING ERRCODE = '42501';
    END IF;
    IF shared_group_role(OLD.group_id) <> 'OWNER'
      AND ((to_jsonb(NEW) - ARRAY['muted', 'revoked_at', 'notification_since', 'ownership_accepted_request_id']) IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['muted', 'revoked_at', 'notification_since', 'ownership_accepted_request_id'])
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
      RAISE EXCEPTION 'Only the owner may change membership grants' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION shared_protect_group() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_bypass_rls() AND app_current_user_id() IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    AND NOT EXISTS (SELECT 1 FROM shared_memberships member JOIN shared_participants participant ON participant.id = member.participant_id
      WHERE member.group_id = OLD.id AND member.participant_id = OLD.ownership_candidate_id
        AND member.user_id = NEW.owner_user_id AND member.revoked_at IS NULL AND participant.is_active
        AND member.ownership_accepted_request_id = OLD.ownership_request_id) THEN
    RAISE EXCEPTION 'Ownership transfer requires recipient consent' USING ERRCODE = '42501';
  END IF;
  IF NEW.currency_code <> OLD.currency_code AND (EXISTS (SELECT 1 FROM shared_entries WHERE group_id = OLD.id) OR EXISTS (SELECT 1 FROM shared_integrations WHERE group_id = OLD.id)) THEN
    RAISE EXCEPTION 'The group currency is fixed after its first entry' USING ERRCODE = '23514';
  END IF;
  IF NOT app_bypass_rls() AND app_current_user_id() IS NOT NULL AND shared_group_role(OLD.id) = 'EDITOR'
    AND (to_jsonb(NEW) - ARRAY['financial_revision', 'revision', 'updated_at']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['financial_revision', 'revision', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the owner may change group settings' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
