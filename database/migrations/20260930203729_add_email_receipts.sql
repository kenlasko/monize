-- Email receipts: a user's dedicated IMAP mailbox is read (never written), each
-- order-confirmation email is stored as text, and a per-merchant parser or an
-- AI draft proposes an enrichment of the bank transaction it pays for
-- (docs/future-plans/email-receipts.md sections 3 to 6, task D1).
--
-- Pure expand: three new tables, nothing existing is altered, so the previous
-- release keeps working against this schema during a rolling deploy. The
-- widening of ai_review_requests that points back at email_receipts is its own
-- migration (one change per file).
--
-- email_receipt_mailboxes: at most one per user (the unique user_id).
-- password_enc is AES-256-GCM ciphertext under ENCRYPTION_KEY, written by the
-- application and never returned to a client. uid_validity and last_uid are the
-- poll's cursor: progress lives here and never as a flag on the mailbox.
-- last_error is bounded to 300 characters by the column itself.
--
-- email_receipt_parsers: a per-merchant extraction definition (jsonb, validated
-- by the application on write). from_domains holds 1 to 10 lower-case sender
-- domains, subject_contains 0 to 10 words. revision is the compare-and-swap
-- counter for edits. status draft|approved and source manual|ai are the
-- vocabulary the CHECKs hold.
--
-- email_receipts: one stored email. UNIQUE (mailbox_id, uid_validity, uid) is
-- the ingestion idempotency (INSERT ... ON CONFLICT DO NOTHING). The raw MIME
-- source and the HTML are not stored: body_text is the converted text, capped at
-- 100,000 characters. ai_review_request_id carries no foreign key on purpose:
-- ai_review_requests references this table, and a two-way pair of foreign keys
-- would make either table impossible to delete from without a deferral.
-- candidate_transaction_ids holds at most 10 ids, with no foreign key (an array
-- cannot carry one); the pipeline re-reads each through the owner's scope.
--
-- Defaults on every column the CHECKs constrain are deliberate: the RLS
-- enforcement spec's generic row seeder invents a `t<n>` string for a varchar
-- column with no default and an integer for an integer one, which the
-- enumerated CHECKs below would reject. The application always writes these
-- columns explicitly.
--
-- User-owned, all three: the ordinary direct policy, and the enable in this file
-- (database/CLAUDE.md, Row-level security rule 1).

CREATE TABLE IF NOT EXISTS email_receipt_mailboxes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    security VARCHAR(10) NOT NULL DEFAULT 'tls',
    username VARCHAR(320) NOT NULL,
    password_enc TEXT NOT NULL,
    folder VARCHAR(255) NOT NULL DEFAULT 'INBOX',
    enabled BOOLEAN NOT NULL DEFAULT false,
    ai_mode VARCHAR(12) NOT NULL DEFAULT 'off',
    auto_apply BOOLEAN NOT NULL DEFAULT false,
    uid_validity BIGINT,
    last_uid BIGINT,
    last_polled_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error VARCHAR(300),
    last_error_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_email_receipt_mailboxes_user UNIQUE (user_id),
    CONSTRAINT ck_email_receipt_mailboxes_host_length
      CHECK (char_length(host) BETWEEN 1 AND 255),
    CONSTRAINT ck_email_receipt_mailboxes_port
      CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT ck_email_receipt_mailboxes_security
      CHECK (security IN ('tls', 'starttls')),
    CONSTRAINT ck_email_receipt_mailboxes_ai_mode
      CHECK (ai_mode IN ('off', 'on_demand', 'automatic'))
);

CREATE TABLE IF NOT EXISTS email_receipt_parsers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    payee_id UUID REFERENCES payees(id) ON DELETE SET NULL,
    from_domains TEXT[] NOT NULL DEFAULT ARRAY['example.invalid']::text[],
    subject_contains TEXT[] NOT NULL DEFAULT '{}'::text[],
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(10) NOT NULL DEFAULT 'draft',
    source VARCHAR(10) NOT NULL DEFAULT 'manual',
    approved_at TIMESTAMPTZ,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_email_receipt_parsers_name_length
      CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT ck_email_receipt_parsers_from_domains
      CHECK (cardinality(from_domains) BETWEEN 1 AND 10),
    CONSTRAINT ck_email_receipt_parsers_subject_contains
      CHECK (cardinality(subject_contains) BETWEEN 0 AND 10),
    CONSTRAINT ck_email_receipt_parsers_status
      CHECK (status IN ('draft', 'approved')),
    CONSTRAINT ck_email_receipt_parsers_source
      CHECK (source IN ('manual', 'ai')),
    CONSTRAINT ck_email_receipt_parsers_revision CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS email_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mailbox_id UUID NOT NULL REFERENCES email_receipt_mailboxes(id) ON DELETE CASCADE,
    uid_validity BIGINT NOT NULL,
    uid BIGINT NOT NULL,
    message_id VARCHAR(500),
    from_address VARCHAR(320) NOT NULL,
    from_domain VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    body_text TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    status_reason VARCHAR(40),
    parser_id UUID REFERENCES email_receipt_parsers(id) ON DELETE SET NULL,
    parsed JSONB,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    candidate_transaction_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    match_kind VARCHAR(20),
    ai_review_request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_email_receipts_message UNIQUE (mailbox_id, uid_validity, uid),
    CONSTRAINT ck_email_receipts_body_length
      CHECK (char_length(body_text) <= 100000),
    CONSTRAINT ck_email_receipts_status
      CHECK (status IN ('pending', 'skipped', 'no_parser', 'parse_failed',
                        'unmatched', 'ambiguous', 'review_conflict', 'review',
                        'ignored')),
    CONSTRAINT ck_email_receipts_match_kind
      CHECK (match_kind IS NULL
             OR match_kind IN ('order_id', 'amount_payee', 'amount_only', 'manual')),
    CONSTRAINT ck_email_receipts_candidates
      CHECK (cardinality(candidate_transaction_ids) <= 10)
);

-- The receipts page and the poll's rematch both read a user's receipts by state,
-- newest first. The unique key above already serves the mailbox cascade.
CREATE INDEX IF NOT EXISTS idx_email_receipts_user_status
    ON email_receipts(user_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_email_receipts_transaction
    ON email_receipts(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_receipts_parser
    ON email_receipts(parser_id) WHERE parser_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_receipt_parsers_user
    ON email_receipt_parsers(user_id);
CREATE INDEX IF NOT EXISTS idx_email_receipt_parsers_payee
    ON email_receipt_parsers(payee_id) WHERE payee_id IS NOT NULL;

-- The touch trigger every sibling table with an updated_at column has.
DROP TRIGGER IF EXISTS update_email_receipt_mailboxes_updated_at ON email_receipt_mailboxes;
CREATE TRIGGER update_email_receipt_mailboxes_updated_at
  BEFORE UPDATE ON email_receipt_mailboxes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_email_receipt_parsers_updated_at ON email_receipt_parsers;
CREATE TRIGGER update_email_receipt_parsers_updated_at
  BEFORE UPDATE ON email_receipt_parsers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_email_receipts_updated_at ON email_receipts;
CREATE TRIGGER update_email_receipts_updated_at
  BEFORE UPDATE ON email_receipts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE email_receipt_mailboxes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_receipt_mailboxes_isolation ON email_receipt_mailboxes;
CREATE POLICY email_receipt_mailboxes_isolation ON email_receipt_mailboxes
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE email_receipt_parsers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_receipt_parsers_isolation ON email_receipt_parsers;
CREATE POLICY email_receipt_parsers_isolation ON email_receipt_parsers
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE email_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_receipts_isolation ON email_receipts;
CREATE POLICY email_receipts_isolation ON email_receipts
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
