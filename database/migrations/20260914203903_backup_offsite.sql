-- Durable state for copying a completed automatic backup off the machine it was
-- written on (docs/specs/backup-off-machine.md section 9). Two tables, both
-- per-user and both in the direct RLS bucket, owner only: no delegate arm, so
-- the uniform policy covers them with no entry in any map.
--
-- backup_offsite_settings -- one row per user, the destinations they chose.
--   s3_access_key_id and s3_secret_access_key hold AES-256-GCM ciphertext
--   produced by EncryptionService under this instance's ENCRYPTION_KEY. They
--   are never returned to the client: the settings API reports whether a secret
--   is set, never its value, and neither column travels in a backup artifact.
--   A user may hold a deployment-default destination (s3_mode = 'deployment',
--   the operator's bucket and the operator's credentials, so every s3_* column
--   here stays NULL) or their own (s3_mode = 'own', this row's bucket and these
--   ciphertext credentials). 'off' is the default and means no S3 destination.
--   email_enabled/email_to are an independent destination: a user may run both
--   for a 3-2-1 arrangement, and neither loosens the rules for the other.
--   The lengths are CHECK constraints rather than VARCHAR(n) so the bound is
--   stated once beside the column it bounds.
--
-- backup_offsite_uploads -- one row per (user, destination, object key), the
--   durable, attributable state EXT-001/EXT-003 require: an upload that failed
--   is a findable row carrying its digest, never a silent success. The UNIQUE
--   constraint is that natural key, and it is what makes a re-dispatch of the
--   same bytes land on the same row instead of a second one (the key carries
--   the egress digest, spec section 6). `status` moving 'pending' -> 'uploading'
--   is a conditional UPDATE on the current status, so when two replicas dispatch
--   the same artifact exactly one claims it and the other writes nothing.

CREATE TABLE IF NOT EXISTS backup_offsite_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    s3_mode TEXT NOT NULL DEFAULT 'off',
    s3_bucket TEXT,
    s3_region TEXT,
    s3_prefix TEXT,
    s3_endpoint TEXT,
    s3_force_path_style BOOLEAN NOT NULL DEFAULT false,
    s3_access_key_id TEXT,
    s3_secret_access_key TEXT,
    email_enabled BOOLEAN NOT NULL DEFAULT false,
    email_to TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_backup_offsite_settings_s3_mode
        CHECK (s3_mode IN ('off', 'deployment', 'own')),
    CONSTRAINT ck_backup_offsite_settings_s3_bucket_length
        CHECK (s3_bucket IS NULL OR char_length(s3_bucket) <= 255),
    CONSTRAINT ck_backup_offsite_settings_s3_region_length
        CHECK (s3_region IS NULL OR char_length(s3_region) <= 64),
    CONSTRAINT ck_backup_offsite_settings_s3_prefix_length
        CHECK (s3_prefix IS NULL OR char_length(s3_prefix) <= 512),
    CONSTRAINT ck_backup_offsite_settings_s3_endpoint_length
        CHECK (s3_endpoint IS NULL OR char_length(s3_endpoint) <= 2048),
    CONSTRAINT ck_backup_offsite_settings_s3_access_key_id_length
        CHECK (s3_access_key_id IS NULL OR char_length(s3_access_key_id) <= 4096),
    CONSTRAINT ck_backup_offsite_settings_s3_secret_access_key_length
        CHECK (s3_secret_access_key IS NULL OR char_length(s3_secret_access_key) <= 4096),
    CONSTRAINT ck_backup_offsite_settings_email_to_length
        CHECK (email_to IS NULL OR char_length(email_to) <= 320)
);

ALTER TABLE backup_offsite_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_offsite_settings_isolation ON backup_offsite_settings;
CREATE POLICY backup_offsite_settings_isolation ON backup_offsite_settings
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

CREATE TABLE IF NOT EXISTS backup_offsite_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    object_key TEXT NOT NULL,
    tier TEXT NOT NULL,
    digest CHAR(64) NOT NULL,
    size_bytes BIGINT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_backup_offsite_uploads_user_dest_key
        UNIQUE (user_id, destination, object_key),
    CONSTRAINT ck_backup_offsite_uploads_destination
        CHECK (destination IN ('s3', 'email')),
    CONSTRAINT ck_backup_offsite_uploads_object_key_length
        CHECK (char_length(object_key) <= 1024),
    CONSTRAINT ck_backup_offsite_uploads_tier
        CHECK (tier IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT ck_backup_offsite_uploads_size_bytes
        CHECK (size_bytes >= 0),
    CONSTRAINT ck_backup_offsite_uploads_status
        CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed',
                          'conflict', 'skipped-unencrypted', 'skipped-too-large'))
);

-- The reaper's sweep: the rows it re-attempts are selected by status and aged
-- by updated_at.
CREATE INDEX IF NOT EXISTS idx_backup_offsite_uploads_status_updated
    ON backup_offsite_uploads(status, updated_at);

-- The per-user status list on the backup settings surface, newest first.
CREATE INDEX IF NOT EXISTS idx_backup_offsite_uploads_user_created
    ON backup_offsite_uploads(user_id, created_at DESC);

ALTER TABLE backup_offsite_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_offsite_uploads_isolation ON backup_offsite_uploads;
CREATE POLICY backup_offsite_uploads_isolation ON backup_offsite_uploads
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
