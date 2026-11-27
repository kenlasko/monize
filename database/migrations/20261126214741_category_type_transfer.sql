-- Transfer categories (docs/specs/transfer-categories.md, PR 2): a third
-- category type beside Income and Expense.
--
-- Expand only, so the previous release keeps running against this schema during
-- a rolling deployment: `categories.is_income` stays (dropped in a later
-- release, `contract-after`), a trigger keeps the two columns in step in both
-- directions, and both split constraints are widened, never narrowed.
--
--   1. `categories.category_type`, backfilled from each category's own flag.
--   2. A categories trigger: type mirror (INV-CATEGORY-003), a child's type from
--      its parent, the subtree cascade, and the refusal to turn a category that
--      a category row holds into a Transfer category.
--   3. FIT backstop (INV-CATEGORY-001, section 13.1): a BEFORE row trigger on the
--      tables that hold a category, serialized against a type change by an
--      advisory lock per category owner (LockScope.CategoryOwner = 10).
--   4. A transfer's split line may hold a category.

-- 1. The column ---------------------------------------------------------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS category_type VARCHAR(10) NOT NULL DEFAULT 'expense';

-- `is_income` is nullable: NULL and false are both Expense. Written against the
-- pre-migration state, so a second pass matches nothing.
--
-- Runs only while the flag exists: 20261127205950_categories_drop_is_income.sql
-- drops it from schema.sql, and a fresh install replays this file on top of it.
-- Wherever the flag exists it does what it always did, and the filename is
-- unchanged, so no deployed database re-runs it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'categories'
          AND column_name = 'is_income'
    ) THEN
        UPDATE categories SET category_type = 'income'
         WHERE is_income IS TRUE AND category_type = 'expense';
    END IF;
END $$;

ALTER TABLE categories DROP CONSTRAINT IF EXISTS chk_categories_category_type;
ALTER TABLE categories ADD CONSTRAINT chk_categories_category_type
    CHECK (category_type IN ('income', 'expense', 'transfer'));

-- A child whose flag differs from its parent's keeps its own type: re-typing it
-- would move what budgets and reports count for it. The figure is on the record.
DO $$
DECLARE mismatched integer;
BEGIN
    SELECT count(*) INTO mismatched
      FROM categories c JOIN categories p ON p.id = c.parent_id
     WHERE c.category_type <> p.category_type;
    RAISE NOTICE 'category_type backfill: % child categories differ from their parent''s type and keep their own', mismatched;
END $$;

-- 2. The categories trigger ---------------------------------------------------
-- Whether a category row, or a setting a later write copies onto one, holds the
-- category. A transfer row accepts any category, so it is not a holder. An
-- override counts only while it can still post (original_date on or after the
-- schedule's next_due_date), as the account-delete count reads them.
CREATE OR REPLACE FUNCTION category_held_by_category_row(p_category_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM transactions
      WHERE category_id = p_category_id AND is_transfer IS NOT TRUE
    UNION ALL SELECT 1 FROM transaction_splits
      WHERE category_id = p_category_id AND transfer_account_id IS NULL
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE category_id = p_category_id AND is_transfer IS NOT TRUE
    UNION ALL SELECT 1 FROM scheduled_transaction_splits
      WHERE category_id = p_category_id AND transfer_account_id IS NULL
    UNION ALL SELECT 1 FROM scheduled_transaction_overrides o
      JOIN scheduled_transactions s ON s.id = o.scheduled_transaction_id
      WHERE s.is_transfer IS NOT TRUE AND o.original_date >= s.next_due_date
        AND (o.category_id = p_category_id
             OR (jsonb_typeof(o.splits) = 'array' AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.splits) e
                   WHERE e->>'categoryId' = p_category_id::text
                     AND COALESCE(e->>'transferAccountId', '') = '')))
    UNION ALL SELECT 1 FROM payees WHERE default_category_id = p_category_id
    UNION ALL SELECT 1 FROM accounts
      WHERE asset_category_id = p_category_id OR interest_category_id = p_category_id
    UNION ALL SELECT 1 FROM payroll_deduction_rules WHERE category_id = p_category_id
    UNION ALL SELECT 1 FROM loan_fees WHERE category_id = p_category_id
  );
$$;

REVOKE ALL ON FUNCTION category_held_by_category_row(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION categories_sync_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE parent_type text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A pod of the previous release writes `is_income` alone, so the type
        -- column holds its default; the flag is the only thing it said.
        IF NEW.category_type = 'expense' AND NEW.is_income IS TRUE THEN
            NEW.category_type := 'income';
        END IF;
    ELSIF NEW.category_type IS DISTINCT FROM OLD.category_type THEN
        NULL; -- the type was written; it wins
    ELSIF NEW.is_income IS DISTINCT FROM OLD.is_income THEN
        -- Only the flag was written (previous release): true is Income, false
        -- is Expense unless the category is a Transfer one.
        IF NEW.is_income IS TRUE THEN
            NEW.category_type := 'income';
        ELSIF OLD.category_type = 'income' THEN
            NEW.category_type := 'expense';
        END IF;
    END IF;

    -- A child takes its parent's type on insert and on a move.
    IF NEW.parent_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
        SELECT p.category_type INTO parent_type FROM categories p WHERE p.id = NEW.parent_id;
        IF parent_type IS NOT NULL THEN
            NEW.category_type := parent_type;
        END IF;
    END IF;

    NEW.is_income := (NEW.category_type = 'income');

    -- A category that becomes a Transfer one must not be held by a category
    -- row. Exclusive against every shared holder of the owner's lock.
    IF NEW.category_type = 'transfer'
       AND (TG_OP = 'UPDATE' AND OLD.category_type IS DISTINCT FROM 'transfer') THEN
        PERFORM pg_advisory_xact_lock(10, hashtext(NEW.user_id::text));
        IF category_held_by_category_row(NEW.id) THEN
            RAISE EXCEPTION 'category % is held by a row that takes only an Income or Expense category', NEW.id
                USING ERRCODE = '23514', CONSTRAINT = 'category_type_held', TABLE = 'categories';
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_categories_sync_type ON categories;
CREATE TRIGGER trg_categories_sync_type
    BEFORE INSERT OR UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION categories_sync_type();

-- A type change or a move re-types the whole subtree. The BEFORE trigger of
-- each descendant mirrors its flag and checks its holders.
CREATE OR REPLACE FUNCTION categories_cascade_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE categories SET category_type = NEW.category_type
     WHERE id IN (
         WITH RECURSIVE sub AS (
             SELECT id FROM categories WHERE parent_id = NEW.id
             UNION ALL
             SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
         ) SELECT id FROM sub)
       AND category_type IS DISTINCT FROM NEW.category_type;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_categories_cascade_type ON categories;
CREATE TRIGGER trg_categories_cascade_type
    AFTER UPDATE ON categories
    FOR EACH ROW
    WHEN (OLD.category_type IS DISTINCT FROM NEW.category_type
          OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
    EXECUTE FUNCTION categories_cascade_type();

-- 3. The FIT backstop ---------------------------------------------------------
-- SECURITY DEFINER with a pinned search_path: under RLS the caller's scope would
-- hide a category it does not own and the check would pass silently. The lock is
-- shared: a type change takes it exclusive before it touches a category, and it
-- is re-entrant, so a path that took it first adds no second acquisition.
CREATE OR REPLACE FUNCTION assert_category_fits_category_row(p_category_id uuid, p_table text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE owner_id uuid; category_kind text;
BEGIN
    SELECT c.user_id INTO owner_id FROM categories c WHERE c.id = p_category_id;
    IF owner_id IS NULL THEN
        RETURN; -- the foreign key reports a missing category
    END IF;
    PERFORM pg_advisory_xact_lock_shared(10, hashtext(owner_id::text));
    -- Read under the lock: a type change that held it has committed by now.
    SELECT c.category_type INTO category_kind FROM categories c WHERE c.id = p_category_id;
    IF category_kind = 'transfer' THEN
        RAISE EXCEPTION 'a Transfer category goes only on a transfer'
            USING ERRCODE = '23514', CONSTRAINT = 'category_fits_row', TABLE = p_table;
    END IF;
END $$;

REVOKE ALL ON FUNCTION assert_category_fits_category_row(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION refuse_transfer_category_on_category_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM assert_category_fits_category_row(NEW.category_id, TG_TABLE_NAME::text);
    RETURN NEW;
END $$;

-- An override's category belongs to its schedule: it is a category row when the
-- schedule is not a transfer. (The override's split JSON is held by the service.)
CREATE OR REPLACE FUNCTION refuse_transfer_category_on_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE schedule_is_transfer boolean;
BEGIN
    SELECT s.is_transfer INTO schedule_is_transfer
      FROM scheduled_transactions s WHERE s.id = NEW.scheduled_transaction_id;
    IF schedule_is_transfer IS NOT TRUE THEN
        PERFORM assert_category_fits_category_row(NEW.category_id, TG_TABLE_NAME::text);
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_transactions_category_fits_insert ON transactions;
CREATE TRIGGER trg_transactions_category_fits_insert
    BEFORE INSERT ON transactions
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE)
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_transactions_category_fits_update ON transactions;
CREATE TRIGGER trg_transactions_category_fits_update
    BEFORE UPDATE OF category_id, is_transfer ON transactions
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE
        AND (OLD.category_id IS DISTINCT FROM NEW.category_id
             OR OLD.is_transfer IS DISTINCT FROM NEW.is_transfer))
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_transaction_splits_category_fits_insert ON transaction_splits;
CREATE TRIGGER trg_transaction_splits_category_fits_insert
    BEFORE INSERT ON transaction_splits
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.transfer_account_id IS NULL)
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_transaction_splits_category_fits_update ON transaction_splits;
CREATE TRIGGER trg_transaction_splits_category_fits_update
    BEFORE UPDATE OF category_id, transfer_account_id ON transaction_splits
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.transfer_account_id IS NULL
        AND (OLD.category_id IS DISTINCT FROM NEW.category_id
             OR OLD.transfer_account_id IS DISTINCT FROM NEW.transfer_account_id))
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_scheduled_transactions_category_fits_insert ON scheduled_transactions;
CREATE TRIGGER trg_scheduled_transactions_category_fits_insert
    BEFORE INSERT ON scheduled_transactions
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE)
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_scheduled_transactions_category_fits_update ON scheduled_transactions;
CREATE TRIGGER trg_scheduled_transactions_category_fits_update
    BEFORE UPDATE OF category_id, is_transfer ON scheduled_transactions
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE
        AND (OLD.category_id IS DISTINCT FROM NEW.category_id
             OR OLD.is_transfer IS DISTINCT FROM NEW.is_transfer))
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_scheduled_splits_category_fits_insert ON scheduled_transaction_splits;
CREATE TRIGGER trg_scheduled_splits_category_fits_insert
    BEFORE INSERT ON scheduled_transaction_splits
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.transfer_account_id IS NULL)
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_scheduled_splits_category_fits_update ON scheduled_transaction_splits;
CREATE TRIGGER trg_scheduled_splits_category_fits_update
    BEFORE UPDATE OF category_id, transfer_account_id ON scheduled_transaction_splits
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.transfer_account_id IS NULL
        AND (OLD.category_id IS DISTINCT FROM NEW.category_id
             OR OLD.transfer_account_id IS DISTINCT FROM NEW.transfer_account_id))
    EXECUTE FUNCTION refuse_transfer_category_on_category_row();

DROP TRIGGER IF EXISTS trg_sched_overrides_category_fits_insert ON scheduled_transaction_overrides;
CREATE TRIGGER trg_sched_overrides_category_fits_insert
    BEFORE INSERT ON scheduled_transaction_overrides
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL)
    EXECUTE FUNCTION refuse_transfer_category_on_override();

DROP TRIGGER IF EXISTS trg_sched_overrides_category_fits_update ON scheduled_transaction_overrides;
CREATE TRIGGER trg_sched_overrides_category_fits_update
    BEFORE UPDATE OF category_id ON scheduled_transaction_overrides
    FOR EACH ROW WHEN (NEW.category_id IS NOT NULL
        AND OLD.category_id IS DISTINCT FROM NEW.category_id)
    EXECUTE FUNCTION refuse_transfer_category_on_override();

-- 4. A transfer's split line may hold a category ------------------------------
ALTER TABLE transaction_splits DROP CONSTRAINT IF EXISTS chk_split_kind_exclusive;
ALTER TABLE transaction_splits ADD CONSTRAINT chk_split_kind_exclusive CHECK (
    (kind = 'category'   AND transfer_account_id IS NULL) OR
    (kind = 'transfer'   AND transfer_account_id IS NOT NULL) OR
    (kind = 'investment' AND category_id IS NULL AND transfer_account_id IS NULL)
);

ALTER TABLE scheduled_transaction_splits DROP CONSTRAINT IF EXISTS chk_scheduled_split_kind_exclusive;
ALTER TABLE scheduled_transaction_splits ADD CONSTRAINT chk_scheduled_split_kind_exclusive CHECK (
    (kind = 'category'   AND transfer_account_id IS NULL AND investment_action IS NULL) OR
    (kind = 'transfer'   AND transfer_account_id IS NOT NULL AND investment_action IS NULL) OR
    (kind = 'investment' AND category_id IS NULL AND transfer_account_id IS NULL AND investment_action IS NOT NULL)
);
