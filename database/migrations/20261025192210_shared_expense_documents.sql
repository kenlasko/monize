-- One attachment pipeline, four explicit parent kinds. A shared copy owns new
-- bytes; no shared row points to a private source document.
ALTER TABLE transaction_attachments ADD COLUMN IF NOT EXISTS shared_group_id UUID;
ALTER TABLE transaction_attachments ADD COLUMN IF NOT EXISTS shared_entry_id UUID;
-- Entity synchronization can create the columns before this SQL-owned journal.
-- Reassert the constraints independently of whether ADD COLUMN did any work.
ALTER TABLE transaction_attachments DROP CONSTRAINT IF EXISTS transaction_attachments_shared_group_id_fkey;
ALTER TABLE transaction_attachments ADD CONSTRAINT transaction_attachments_shared_group_id_fkey
  FOREIGN KEY (shared_group_id) REFERENCES shared_groups(id) ON DELETE CASCADE;
ALTER TABLE transaction_attachments DROP CONSTRAINT IF EXISTS transaction_attachments_shared_entry_id_fkey;
ALTER TABLE transaction_attachments ADD CONSTRAINT transaction_attachments_shared_entry_id_fkey
  FOREIGN KEY (shared_entry_id) REFERENCES shared_entries(id) ON DELETE CASCADE;
ALTER TABLE transaction_attachments ADD COLUMN IF NOT EXISTS upload_request_id VARCHAR(36);
ALTER TABLE transaction_attachments ADD COLUMN IF NOT EXISTS upload_fingerprint VARCHAR(64);
ALTER TABLE transaction_attachments ADD COLUMN IF NOT EXISTS document_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transaction_attachments DROP CONSTRAINT IF EXISTS chk_attachment_one_parent;
ALTER TABLE transaction_attachments ADD CONSTRAINT chk_attachment_one_parent CHECK (
  num_nonnulls(transaction_id, warranty_id, shared_group_id, shared_entry_id) = 1);
CREATE INDEX IF NOT EXISTS idx_attachments_shared_group ON transaction_attachments(shared_group_id) WHERE shared_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_shared_entry ON transaction_attachments(shared_entry_id) WHERE shared_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attachments_upload_request ON transaction_attachments(user_id, upload_request_id) WHERE upload_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION shared_document_group(p_group UUID, p_entry UUID) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_group, (SELECT group_id FROM shared_entries WHERE id = p_entry))
$$;

-- The old user_id read arm deliberately excludes shared documents. Otherwise an
-- uploader whose membership was revoked could still read their shared copies.
DROP POLICY IF EXISTS transaction_attachments_isolation ON transaction_attachments;
DROP POLICY IF EXISTS shared_attachments_read ON transaction_attachments;
CREATE POLICY shared_attachments_read ON transaction_attachments FOR SELECT USING (
  (SELECT app_bypass_rls()) OR
  (shared_group_id IS NULL AND shared_entry_id IS NULL AND user_id = (SELECT app_current_user_id())) OR
  shared_group_role(shared_document_group(shared_group_id, shared_entry_id)) IS NOT NULL);
DROP POLICY IF EXISTS shared_attachments_insert ON transaction_attachments;
CREATE POLICY shared_attachments_insert ON transaction_attachments FOR INSERT WITH CHECK (
  (SELECT app_bypass_rls()) OR (user_id = (SELECT app_current_user_id()) AND
    ((shared_group_id IS NULL AND shared_entry_id IS NULL) OR
     (shared_group_id IS NOT NULL AND shared_group_writable(shared_group_id)) OR
     (shared_entry_id IS NOT NULL AND shared_entry_writable(shared_entry_id)))));
DROP POLICY IF EXISTS shared_attachments_update ON transaction_attachments;
CREATE POLICY shared_attachments_update ON transaction_attachments FOR UPDATE USING (
  (SELECT app_bypass_rls()) OR
  (shared_group_id IS NULL AND shared_entry_id IS NULL AND user_id = (SELECT app_current_user_id())) OR
  (shared_group_writable(shared_document_group(shared_group_id, shared_entry_id)) AND
    (user_id = (SELECT app_current_user_id()) OR shared_group_role(shared_document_group(shared_group_id, shared_entry_id)) = 'OWNER'))
) WITH CHECK (
  (SELECT app_bypass_rls()) OR
  (shared_group_id IS NULL AND shared_entry_id IS NULL AND user_id = (SELECT app_current_user_id())) OR
  (shared_group_writable(shared_document_group(shared_group_id, shared_entry_id)) AND
    (user_id = (SELECT app_current_user_id()) OR shared_group_role(shared_document_group(shared_group_id, shared_entry_id)) = 'OWNER')));
DROP POLICY IF EXISTS shared_attachments_delete ON transaction_attachments;
CREATE POLICY shared_attachments_delete ON transaction_attachments FOR DELETE USING (
  (SELECT app_bypass_rls()) OR
  (shared_group_id IS NULL AND shared_entry_id IS NULL AND user_id = (SELECT app_current_user_id())) OR
  (shared_group_writable(shared_document_group(shared_group_id, shared_entry_id)) AND
    (user_id = (SELECT app_current_user_id()) OR shared_group_role(shared_document_group(shared_group_id, shared_entry_id)) = 'OWNER')));

-- The existing owner-only write policy stays; membership adds a SELECT arm.
DROP POLICY IF EXISTS shared_attachment_blobs_read ON attachment_blobs;
CREATE POLICY shared_attachment_blobs_read ON attachment_blobs FOR SELECT USING (
  EXISTS (SELECT 1 FROM transaction_attachments a WHERE a.id = attachment_blobs.attachment_id
    AND (a.shared_group_id IS NOT NULL OR a.shared_entry_id IS NOT NULL)));

ALTER TABLE transaction_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_blobs ENABLE ROW LEVEL SECURITY;

-- A scan pair has one parent and one uploader. Deferred because the primary and
-- original can be restored in either order, then checked together at commit.
CREATE OR REPLACE FUNCTION check_attachment_pair_parent() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM transaction_attachments a JOIN transaction_attachments p ON p.id = a.original_of_attachment_id
    WHERE (a.id = NEW.id OR p.id = NEW.id) AND
      (a.user_id <> p.user_id OR a.transaction_id IS DISTINCT FROM p.transaction_id
       OR a.warranty_id IS DISTINCT FROM p.warranty_id OR a.shared_group_id IS DISTINCT FROM p.shared_group_id
       OR a.shared_entry_id IS DISTINCT FROM p.shared_entry_id OR a.document_kind <> p.document_kind
       OR p.original_of_attachment_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'A scanned document and its original must have the same parent and uploader' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS attachment_pair_parent ON transaction_attachments;
CREATE CONSTRAINT TRIGGER attachment_pair_parent AFTER INSERT OR UPDATE ON transaction_attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_attachment_pair_parent();

-- Publication uses new bytes. A visible shared document can move only within
-- its current group, including its scan original in the same transaction.
CREATE OR REPLACE FUNCTION shared_protect_document_parent() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
    OR NEW.warranty_id IS DISTINCT FROM OLD.warranty_id
    OR shared_document_group(OLD.shared_group_id, OLD.shared_entry_id) IS NULL
    OR shared_document_group(NEW.shared_group_id, NEW.shared_entry_id) IS DISTINCT FROM
       shared_document_group(OLD.shared_group_id, OLD.shared_entry_id) THEN
    RAISE EXCEPTION 'Publish a new copy to change document visibility' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shared_attachment_parent_identity ON transaction_attachments;
CREATE TRIGGER shared_attachment_parent_identity BEFORE UPDATE ON transaction_attachments FOR EACH ROW
WHEN (OLD.shared_group_id IS NOT NULL OR OLD.shared_entry_id IS NOT NULL OR NEW.shared_group_id IS NOT NULL OR NEW.shared_entry_id IS NOT NULL)
EXECUTE FUNCTION shared_protect_document_parent();
