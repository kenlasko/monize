-- Drop categories.is_income (#2478; docs/specs/transfer-categories.md sections
-- 11 and 17.3): the contract half of 20261126214741_category_type_transfer.sql.
-- `category_type` is the only statement of a category's type.
--
-- contract-after: 1.22.0
-- 1.22.0 is the release that writes the type beside the flag; from the release
-- after it nothing reads or writes the flag. Every release up to and including
-- 1.22.0 maps the column in its entity, so a pod of the previous release fails
-- its category reads and writes for the length of a rolling update onto this
-- schema (and a previous release's open tab sending `isIncome` is refused).
-- The maintainer accepted that on #2478; a Recreate rollout avoids it.
--
-- 1. categories_sync_type without the mirror. It keeps its other two jobs: a
--    child takes its parent's type on insert and on a move, and a category a
--    category row holds cannot become a Transfer one (INV-CATEGORY-003,
--    INV-CATEGORY-001). Replaced before the drop, so no version of the function
--    names a column that is gone.
-- 2. The column. Every statement is a no-op on re-apply.

-- 1. The trigger function ------------------------------------------------------
CREATE OR REPLACE FUNCTION categories_sync_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE parent_type text;
BEGIN
    -- A child takes its parent's type on insert and on a move.
    IF NEW.parent_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
        SELECT p.category_type INTO parent_type FROM categories p WHERE p.id = NEW.parent_id;
        IF parent_type IS NOT NULL THEN
            NEW.category_type := parent_type;
        END IF;
    END IF;

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

-- 2. The column ----------------------------------------------------------------
ALTER TABLE categories DROP COLUMN IF EXISTS is_income;
