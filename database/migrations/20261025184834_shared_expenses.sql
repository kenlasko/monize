-- Shared expenses: independent group journal, authenticated memberships and
-- private ledger projections. Policies and deferred sum constraints ship with
-- the tables. Existing account/transaction shapes remain valid during rollout.

CREATE TABLE IF NOT EXISTS shared_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL CHECK (char_length(btrim(name)) > 0),
    description TEXT CHECK (description IS NULL OR char_length(description) <= 750),
    currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    financial_revision INTEGER NOT NULL DEFAULT 0 CHECK (financial_revision >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    split_template JSONB,
    is_detached_copy BOOLEAN NOT NULL DEFAULT false,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shared_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL CHECK (char_length(btrim(name)) > 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, group_id)
);

CREATE TABLE IF NOT EXISTS shared_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role VARCHAR(10) NOT NULL DEFAULT 'EDITOR' CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
    muted BOOLEAN NOT NULL DEFAULT false,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id, group_id) REFERENCES shared_participants(id, group_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_member_user ON shared_memberships(group_id, user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_member_participant ON shared_memberships(participant_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_member_owner ON shared_memberships(group_id) WHERE revoked_at IS NULL AND role = 'OWNER';

-- Legacy user-FK normalization also runs on fresh schema installs. Restore the
-- shared journal's erasure boundary after that replay: ownership/membership
-- must be detached explicitly before deleting a user, not cascaded away.
ALTER TABLE shared_groups DROP CONSTRAINT IF EXISTS shared_groups_owner_user_id_fkey;
ALTER TABLE shared_groups ADD CONSTRAINT shared_groups_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE shared_memberships DROP CONSTRAINT IF EXISTS shared_memberships_user_id_fkey;
ALTER TABLE shared_memberships ADD CONSTRAINT shared_memberships_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS shared_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL CHECK (char_length(btrim(name)) > 0),
    payee_id UUID REFERENCES payees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_person_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    person_id UUID NOT NULL,
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL,
    FOREIGN KEY (person_id, user_id) REFERENCES shared_people(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (participant_id, group_id) REFERENCES shared_participants(id, group_id) ON DELETE CASCADE,
    UNIQUE (user_id, participant_id),
    UNIQUE (person_id, group_id)
);

CREATE TABLE IF NOT EXISTS shared_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL,
    role VARCHAR(10) NOT NULL CHECK (role IN ('EDITOR', 'VIEWER')),
    token_hash VARCHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    target_email VARCHAR(254),
    group_name VARCHAR(120) NOT NULL,
    participant_name VARCHAR(80) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id, group_id) REFERENCES shared_participants(id, group_id)
);

CREATE TABLE IF NOT EXISTS shared_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(12) NOT NULL CHECK (type IN ('EXPENSE', 'REFUND', 'INCOME', 'REPAYMENT')),
    state VARCHAR(10) NOT NULL DEFAULT 'POSTED' CHECK (state IN ('DRAFT', 'POSTED', 'REVERSED')),
    draft_reason VARCHAR(20) CHECK (draft_reason IS NULL OR draft_reason IN ('FUTURE_DATE', 'MISSING_RATE')),
    title VARCHAR(120) NOT NULL CHECK (char_length(btrim(title)) > 0),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 750),
    category_label VARCHAR(60),
    entry_date DATE NOT NULL,
    original_amount NUMERIC(20,4) NOT NULL CHECK (original_amount > 0 AND original_amount <= 999999999999),
    original_currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
    group_amount NUMERIC(20,4) CHECK (group_amount >= 0 AND group_amount <= 999999999999),
    fx_rate NUMERIC(20,10) CHECK (fx_rate > 0),
    fx_rate_date DATE,
    fx_source VARCHAR(30),
    split_mode VARCHAR(10) NOT NULL DEFAULT 'EQUAL' CHECK (split_mode IN ('EQUAL', 'EXACT', 'PERCENT', 'WEIGHT')),
    rounding_seed VARCHAR(64) NOT NULL,
    allocation_version INTEGER NOT NULL DEFAULT 1 CHECK (allocation_version = 1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    financial_revision INTEGER NOT NULL DEFAULT 1 CHECK (financial_revision > 0),
    source_entry_id UUID,
    from_participant_id UUID,
    to_participant_id UUID,
    reversal_reason TEXT CHECK (reversal_reason IS NULL OR char_length(reversal_reason) <= 750),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, group_id),
    FOREIGN KEY (source_entry_id, group_id) REFERENCES shared_entries(id, group_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (from_participant_id, group_id) REFERENCES shared_participants(id, group_id),
    FOREIGN KEY (to_participant_id, group_id) REFERENCES shared_participants(id, group_id),
    CHECK ((type = 'REFUND') = (source_entry_id IS NOT NULL)),
    CHECK ((type = 'REPAYMENT' AND from_participant_id IS NOT NULL AND to_participant_id IS NOT NULL AND from_participant_id <> to_participant_id)
        OR (type <> 'REPAYMENT' AND from_participant_id IS NULL AND to_participant_id IS NULL)),
    CHECK (state <> 'POSTED' OR (group_amount IS NOT NULL AND fx_rate IS NOT NULL AND draft_reason IS NULL)),
    CHECK ((group_amount IS NULL) = (fx_rate IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_shared_entries_group_date ON shared_entries(group_id, entry_date DESC, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_shared_entries_refund ON shared_entries(source_entry_id) WHERE source_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shared_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    entry_id UUID NOT NULL,
    participant_id UUID NOT NULL,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('SHARE', 'CONTRIBUTION')),
    original_amount NUMERIC(20,4) NOT NULL CHECK (original_amount >= 0),
    group_amount NUMERIC(20,4) CHECK (group_amount >= 0),
    instruction_value VARCHAR(32),
    FOREIGN KEY (entry_id, group_id) REFERENCES shared_entries(id, group_id) ON DELETE CASCADE,
    FOREIGN KEY (participant_id, group_id) REFERENCES shared_participants(id, group_id),
    UNIQUE (entry_id, participant_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_shared_allocations_person ON shared_allocations(participant_id, entry_id);

CREATE TABLE IF NOT EXISTS shared_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    entry_id UUID,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name VARCHAR(80) NOT NULL,
    action VARCHAR(40) NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id, group_id) REFERENCES shared_entries(id, group_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shared_activity_group_date ON shared_activity(group_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS shared_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE RESTRICT,
    participant_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id, group_id) REFERENCES shared_participants(id, group_id),
    UNIQUE (user_id, group_id),
    UNIQUE (account_id),
    UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_postings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE RESTRICT,
    entry_id UUID NOT NULL,
    integration_id UUID NOT NULL,
    accepted_revision INTEGER NOT NULL CHECK (accepted_revision > 0),
    input_fingerprint VARCHAR(64) NOT NULL,
    accepted_snapshot JSONB NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    payee_id UUID REFERENCES payees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id, group_id) REFERENCES shared_entries(id, group_id),
    FOREIGN KEY (integration_id, user_id) REFERENCES shared_integrations(id, user_id),
    UNIQUE (user_id, entry_id),
    UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_ledger_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id UUID NOT NULL,
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('BANK', 'COST', 'COUNTERPART', 'FX')),
    created_by_bridge BOOLEAN NOT NULL DEFAULT false,
    before_shape JSONB,
    allocated_amount NUMERIC(20,4) NOT NULL,
    FOREIGN KEY (posting_id, user_id) REFERENCES shared_postings(id, user_id) ON DELETE CASCADE,
    UNIQUE (transaction_id)
);

CREATE TABLE IF NOT EXISTS shared_commands (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES shared_groups(id) ON DELETE CASCADE,
    payload_hash VARCHAR(64) NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Narrow RLS predicates read as the table owner to avoid group/membership
-- recursion. They derive the principal from the scoped GUC, never a caller ID.
-- PUBLIC execution is needed by policies; the result is only this principal's role.
CREATE OR REPLACE FUNCTION shared_group_role(p_group_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN g.owner_user_id = app_current_user_id() THEN 'OWNER'
    ELSE (SELECT m.role FROM shared_memberships m WHERE m.group_id = g.id
      AND m.user_id = app_current_user_id() AND m.revoked_at IS NULL LIMIT 1) END
  FROM shared_groups g WHERE g.id = p_group_id
    AND app_current_user_id() = app_real_user_id()
$$;

CREATE OR REPLACE FUNCTION shared_group_writable(p_group_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM shared_groups g WHERE g.id = p_group_id
    AND (g.archived_at IS NULL OR (current_setting('app.preserve_timestamps', true) = 'on' AND g.owner_user_id = app_current_user_id())) AND shared_group_role(g.id) IN ('OWNER', 'EDITOR'))
$$;

CREATE OR REPLACE FUNCTION shared_entry_writable(p_entry_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM shared_entries e WHERE e.id = p_entry_id
    AND shared_group_writable(e.group_id)
    AND (shared_group_role(e.group_id) = 'OWNER' OR e.created_by_user_id = app_current_user_id()))
$$;

-- The invitation hash is a transaction-local capability set only after JWT auth.
-- Knowing a group UUID grants nothing. Targeted invites also bind verified email.
CREATE OR REPLACE FUNCTION shared_invitation_allows(p_group_id UUID, p_participant_id UUID, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM shared_invitations i JOIN users u ON u.id = app_current_user_id()
    JOIN shared_groups g ON g.id = i.group_id
    WHERE i.group_id = p_group_id AND i.participant_id = p_participant_id AND i.role = p_role
      AND i.token_hash = NULLIF(current_setting('app.shared_invitation_hash', true), '')
      AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP
      AND g.archived_at IS NULL AND u.is_active AND app_current_user_id() = app_real_user_id()
      AND (i.target_email IS NULL OR (u.email_verified AND lower(u.email) = lower(i.target_email))))
$$;

DROP POLICY IF EXISTS shared_groups_read ON shared_groups;
CREATE POLICY shared_groups_read ON shared_groups FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(id) IS NOT NULL OR EXISTS (SELECT 1 FROM shared_invitations i WHERE i.group_id = shared_groups.id AND shared_invitation_allows(i.group_id, i.participant_id, i.role)));
DROP POLICY IF EXISTS shared_groups_insert ON shared_groups;
CREATE POLICY shared_groups_insert ON shared_groups FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR (owner_user_id = (SELECT app_current_user_id()) AND owner_user_id = (SELECT app_real_user_id())));
DROP POLICY IF EXISTS shared_groups_update ON shared_groups;
CREATE POLICY shared_groups_update ON shared_groups FOR UPDATE USING ((SELECT app_bypass_rls()) OR shared_group_role(id) IN ('OWNER', 'EDITOR')) WITH CHECK ((SELECT app_bypass_rls()) OR shared_group_role(id) IN ('OWNER', 'EDITOR'));
DROP POLICY IF EXISTS shared_groups_delete ON shared_groups;
CREATE POLICY shared_groups_delete ON shared_groups FOR DELETE USING ((SELECT app_bypass_rls()) OR (owner_user_id = (SELECT app_current_user_id()) AND owner_user_id = (SELECT app_real_user_id())));

DROP POLICY IF EXISTS shared_memberships_read ON shared_memberships;
CREATE POLICY shared_memberships_read ON shared_memberships FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) IS NOT NULL);
DROP POLICY IF EXISTS shared_memberships_insert ON shared_memberships;
CREATE POLICY shared_memberships_insert ON shared_memberships FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR (user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id()) AND (shared_group_role(group_id) = 'OWNER' OR shared_invitation_allows(group_id, participant_id, role))));
DROP POLICY IF EXISTS shared_memberships_update ON shared_memberships;
CREATE POLICY shared_memberships_update ON shared_memberships FOR UPDATE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER' OR (user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id()))) WITH CHECK ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER' OR (user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id())));
DROP POLICY IF EXISTS shared_memberships_delete ON shared_memberships;
CREATE POLICY shared_memberships_delete ON shared_memberships FOR DELETE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');

DROP POLICY IF EXISTS shared_participants_read ON shared_participants;
CREATE POLICY shared_participants_read ON shared_participants FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) IS NOT NULL);
DROP POLICY IF EXISTS shared_participants_write ON shared_participants;
CREATE POLICY shared_participants_write ON shared_participants USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER') WITH CHECK ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');
DROP POLICY IF EXISTS shared_invitations_read ON shared_invitations;
CREATE POLICY shared_invitations_read ON shared_invitations FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER' OR token_hash = NULLIF(current_setting('app.shared_invitation_hash', true), ''));
DROP POLICY IF EXISTS shared_invitations_insert ON shared_invitations;
CREATE POLICY shared_invitations_insert ON shared_invitations FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');
DROP POLICY IF EXISTS shared_invitations_update ON shared_invitations;
CREATE POLICY shared_invitations_update ON shared_invitations FOR UPDATE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER' OR token_hash = NULLIF(current_setting('app.shared_invitation_hash', true), '')) WITH CHECK ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER' OR (token_hash = NULLIF(current_setting('app.shared_invitation_hash', true), '') AND consumed_by_user_id = (SELECT app_current_user_id())));
DROP POLICY IF EXISTS shared_invitations_delete ON shared_invitations;
CREATE POLICY shared_invitations_delete ON shared_invitations FOR DELETE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');

DROP POLICY IF EXISTS shared_entries_read ON shared_entries;
CREATE POLICY shared_entries_read ON shared_entries FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) IS NOT NULL);
DROP POLICY IF EXISTS shared_entries_insert ON shared_entries;
CREATE POLICY shared_entries_insert ON shared_entries FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR (shared_group_writable(group_id) AND created_by_user_id = (SELECT app_current_user_id())));
DROP POLICY IF EXISTS shared_entries_update ON shared_entries;
CREATE POLICY shared_entries_update ON shared_entries FOR UPDATE USING ((SELECT app_bypass_rls()) OR shared_entry_writable(id)) WITH CHECK ((SELECT app_bypass_rls()) OR shared_entry_writable(id));
DROP POLICY IF EXISTS shared_entries_delete ON shared_entries;
CREATE POLICY shared_entries_delete ON shared_entries FOR DELETE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');

DROP POLICY IF EXISTS shared_allocations_read ON shared_allocations;
CREATE POLICY shared_allocations_read ON shared_allocations FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) IS NOT NULL);
DROP POLICY IF EXISTS shared_allocations_insert ON shared_allocations;
CREATE POLICY shared_allocations_insert ON shared_allocations FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR shared_entry_writable(entry_id));
DROP POLICY IF EXISTS shared_allocations_update ON shared_allocations;
CREATE POLICY shared_allocations_update ON shared_allocations FOR UPDATE USING ((SELECT app_bypass_rls()) OR shared_entry_writable(entry_id)) WITH CHECK ((SELECT app_bypass_rls()) OR shared_entry_writable(entry_id));
DROP POLICY IF EXISTS shared_allocations_delete ON shared_allocations;
CREATE POLICY shared_allocations_delete ON shared_allocations FOR DELETE USING ((SELECT app_bypass_rls()) OR shared_entry_writable(entry_id));

DROP POLICY IF EXISTS shared_activity_read ON shared_activity;
CREATE POLICY shared_activity_read ON shared_activity FOR SELECT USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) IS NOT NULL);
DROP POLICY IF EXISTS shared_activity_insert ON shared_activity;
CREATE POLICY shared_activity_insert ON shared_activity FOR INSERT WITH CHECK ((SELECT app_bypass_rls()) OR (actor_user_id = (SELECT app_current_user_id()) AND (shared_group_role(group_id) IN ('OWNER', 'EDITOR') OR (shared_group_role(group_id) = 'VIEWER' AND action IN ('MEMBER_JOINED', 'MEMBER_LEFT')))) OR (shared_group_role(group_id) = 'OWNER' AND current_setting('app.preserve_timestamps', true) = 'on'));
DROP POLICY IF EXISTS shared_activity_delete ON shared_activity;
CREATE POLICY shared_activity_delete ON shared_activity FOR DELETE USING ((SELECT app_bypass_rls()) OR shared_group_role(group_id) = 'OWNER');

DO $$
DECLARE
  t TEXT;
  private_tables TEXT[] := ARRAY['shared_people', 'shared_person_links', 'shared_integrations', 'shared_postings', 'shared_ledger_links', 'shared_commands'];
BEGIN
  FOREACH t IN ARRAY private_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ((user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id())) OR (SELECT app_bypass_rls())) WITH CHECK ((user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id())) OR (SELECT app_bypass_rls()))', t || '_isolation', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE shared_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_activity ENABLE ROW LEVEL SECURITY;

-- Parent and principal identities are immutable; moving a child between journals
-- would invalidate both authorization and the deferred conservation check.
CREATE OR REPLACE FUNCTION shared_protect_identity() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE col TEXT;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW)->col IS DISTINCT FROM to_jsonb(OLD)->col THEN
      RAISE EXCEPTION 'Shared journal identity cannot be reassigned' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shared_participants_identity ON shared_participants;
CREATE TRIGGER shared_participants_identity BEFORE UPDATE ON shared_participants FOR EACH ROW EXECUTE FUNCTION shared_protect_identity('id', 'group_id');
DROP TRIGGER IF EXISTS shared_memberships_identity ON shared_memberships;
CREATE TRIGGER shared_memberships_identity BEFORE UPDATE ON shared_memberships FOR EACH ROW EXECUTE FUNCTION shared_protect_identity('id', 'group_id', 'participant_id', 'user_id');
DROP TRIGGER IF EXISTS shared_entries_identity ON shared_entries;
CREATE TRIGGER shared_entries_identity BEFORE UPDATE ON shared_entries FOR EACH ROW EXECUTE FUNCTION shared_protect_identity('id', 'group_id', 'type', 'source_entry_id', 'rounding_seed');
DROP TRIGGER IF EXISTS shared_allocations_identity ON shared_allocations;
CREATE TRIGGER shared_allocations_identity BEFORE UPDATE ON shared_allocations FOR EACH ROW EXECUTE FUNCTION shared_protect_identity('id', 'group_id', 'entry_id', 'participant_id', 'kind');
DROP TRIGGER IF EXISTS shared_invitations_identity ON shared_invitations;
CREATE TRIGGER shared_invitations_identity BEFORE UPDATE ON shared_invitations FOR EACH ROW EXECUTE FUNCTION shared_protect_identity('id', 'group_id', 'participant_id', 'role', 'token_hash', 'target_email', 'expires_at', 'group_name', 'participant_name');

CREATE OR REPLACE FUNCTION shared_protect_membership() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_bypass_rls() AND app_current_user_id() IS NOT NULL AND shared_group_role(OLD.group_id) <> 'OWNER'
    AND ((to_jsonb(NEW) - ARRAY['muted', 'revoked_at', 'notification_since']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['muted', 'revoked_at', 'notification_since'])
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'Only the owner may change membership grants' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shared_memberships_protect ON shared_memberships;
CREATE TRIGGER shared_memberships_protect BEFORE UPDATE ON shared_memberships FOR EACH ROW EXECUTE FUNCTION shared_protect_membership();

CREATE OR REPLACE FUNCTION shared_protect_invitation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_by_user_id IS DISTINCT FROM OLD.consumed_by_user_id) THEN
    RAISE EXCEPTION 'A claimed invitation cannot be reused' USING ERRCODE = '23514';
  END IF;
  IF NOT app_bypass_rls() AND app_current_user_id() IS NOT NULL AND shared_group_role(OLD.group_id) IS DISTINCT FROM 'OWNER'
    AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR OLD.revoked_at IS NOT NULL OR OLD.expires_at <= CURRENT_TIMESTAMP
      OR NEW.consumed_at IS NULL OR NEW.consumed_by_user_id IS DISTINCT FROM app_current_user_id()) THEN
    RAISE EXCEPTION 'An invitation may only be claimed by its recipient' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shared_invitations_protect ON shared_invitations;
CREATE TRIGGER shared_invitations_protect BEFORE UPDATE ON shared_invitations FOR EACH ROW EXECUTE FUNCTION shared_protect_invitation();

CREATE OR REPLACE FUNCTION shared_protect_group() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
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
DROP TRIGGER IF EXISTS shared_groups_protect ON shared_groups;
CREATE TRIGGER shared_groups_protect BEFORE UPDATE ON shared_groups FOR EACH ROW EXECUTE FUNCTION shared_protect_group();

-- A deferred constraint sees the final entry and allocations in the transaction,
-- including replacing an allocation set. No session flag disables conservation.
CREATE OR REPLACE FUNCTION shared_validate_entry_allocations() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE entry_key UUID; e shared_entries%ROWTYPE; k TEXT; a NUMERIC; b NUMERIC; unknowns INTEGER; n INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'shared_entries' THEN entry_key := COALESCE(NEW.id, OLD.id);
  ELSE entry_key := COALESCE(NEW.entry_id, OLD.entry_id); END IF;
  SELECT * INTO e FROM shared_entries WHERE id = entry_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF e.type = 'REPAYMENT' THEN
    IF EXISTS (SELECT 1 FROM shared_allocations WHERE entry_id = e.id) THEN
      RAISE EXCEPTION 'A repayment has no beneficiary allocation' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  FOREACH k IN ARRAY ARRAY['SHARE', 'CONTRIBUTION'] LOOP
    SELECT count(*), COALESCE(sum(original_amount), 0), COALESCE(sum(group_amount), 0), count(*) FILTER (WHERE group_amount IS NULL)
      INTO n, a, b, unknowns FROM shared_allocations WHERE entry_id = e.id AND kind = k;
    IF n = 0 OR a <> e.original_amount OR
       (e.group_amount IS NOT NULL AND (unknowns > 0 OR b <> e.group_amount)) OR
       (e.group_amount IS NULL AND unknowns <> n) THEN
      RAISE EXCEPTION 'Shared allocations must preserve the entry total' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS shared_entries_sum ON shared_entries;
CREATE CONSTRAINT TRIGGER shared_entries_sum AFTER INSERT OR UPDATE ON shared_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared_validate_entry_allocations();
DROP TRIGGER IF EXISTS shared_allocations_sum ON shared_allocations;
CREATE CONSTRAINT TRIGGER shared_allocations_sum AFTER INSERT OR UPDATE OR DELETE ON shared_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared_validate_entry_allocations();

DROP TRIGGER IF EXISTS shared_groups_updated ON shared_groups;
CREATE TRIGGER shared_groups_updated BEFORE UPDATE ON shared_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS shared_entries_updated ON shared_entries;
CREATE TRIGGER shared_entries_updated BEFORE UPDATE ON shared_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS shared_postings_updated ON shared_postings;
CREATE TRIGGER shared_postings_updated BEFORE UPDATE ON shared_postings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
