-- Guided tours (What's New Phase 2): per-user tracking of completed/dismissed tours.
--   tour_progress: jsonb map keyed by opaque tour id ->
--     { status: 'completed'|'dismissed', version?: string, updatedAt: ISO }.
--   Server-managed and written via the tenantTx (RLS-compliant) atomic
--   jsonb-merge UPDATE, so concurrent fire-and-forget saves from multiple tabs
--   do not last-writer-wins the whole map.
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS tour_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
