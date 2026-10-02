import type { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";

/**
 * The id of the user's tag called `name`, ignoring case; null when there is none.
 * Read-only: the preview asks it, and so does the create below.
 */
export async function findTagId(
  m: EntityManager,
  userId: string,
  name: string,
): Promise<string | null> {
  return (
    returnedRows<{ id: string }>(
      await m.query(
        `SELECT id FROM tags WHERE user_id = $1 AND LOWER(name) = LOWER($2)`,
        [userId, name],
      ),
    )[0]?.id ?? null
  );
}

/**
 * The id of the user's tag called `name`, created when there is none (spec
 * section 7b: the operation type becomes a tag).
 *
 * Tag names are unique per user ignoring case (`idx_tags_user_name` over
 * `LOWER(name)`), so the lookup compares `LOWER(name)` and "Card payment" finds
 * "card payment". The create is `INSERT ... ON CONFLICT DO NOTHING` with no
 * conflict target, which stands for any unique violation including this
 * expression index (a target would have to repeat the expression). A conflict
 * returns nothing, and the row that won is read again: two syncs that meet the
 * same new tag converge on one row, neither failing on the key and neither
 * aborting the transaction the way a caught unique violation would.
 *
 * Everything runs on the caller's manager, so the tag is written, or rolled
 * back, with the sync that needed it. No action-history entry is recorded: it is
 * recorded outside a transaction by contract, and the file import records none
 * either. `cache` (keyed by the lower-cased name) serves a batch one lookup per
 * name.
 */
export async function findOrCreateTagId(
  m: EntityManager,
  userId: string,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let id = await findTagId(m, userId, name);
  if (id === null) {
    id =
      returnedRows<{ id: string }>(
        await m.query(
          `INSERT INTO tags (user_id, name)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, name],
        ),
      )[0]?.id ?? (await findTagId(m, userId, name));
  }
  if (id === null) {
    throw new Error(`The tag "${name}" could be neither found nor created`);
  }
  cache.set(key, id);
  return id;
}
