-- Phase 2 / 2C granular: split each shared-resource "manage" capability into
-- separate create / edit / delete flags (per delegation). Backfills the new
-- columns from the old can_manage_* booleans, then drops the old columns.
-- Idempotent: safe to run multiple times.

ALTER TABLE account_delegates
    ADD COLUMN IF NOT EXISTS payees_can_create     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS payees_can_edit       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS payees_can_delete     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS categories_can_create BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS categories_can_edit   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS categories_can_delete BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tags_can_create       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tags_can_edit         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tags_can_delete       BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'account_delegates'
          AND column_name = 'can_manage_payees'
    ) THEN
        UPDATE account_delegates SET
            payees_can_create     = can_manage_payees,
            payees_can_edit       = can_manage_payees,
            payees_can_delete     = can_manage_payees,
            categories_can_create = can_manage_categories,
            categories_can_edit   = can_manage_categories,
            categories_can_delete = can_manage_categories,
            tags_can_create       = can_manage_tags,
            tags_can_edit         = can_manage_tags,
            tags_can_delete       = can_manage_tags;

        ALTER TABLE account_delegates
            DROP COLUMN can_manage_payees,
            DROP COLUMN can_manage_categories,
            DROP COLUMN can_manage_tags;
    END IF;
END $$;
