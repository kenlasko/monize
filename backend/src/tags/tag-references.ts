import { EntityManager } from "typeorm";
import {
  RecordInUseEntry,
  ReferenceCount,
  countReferences,
  countReferencesById,
} from "../common/helpers/record-in-use";

/** What still uses a tag: one entry per kind of row carrying it. */
export type TagReferenceKind =
  | "transactions"
  | "scheduledTransactions"
  | "securities"
  | "rules"
  | "customReports";

/**
 * How a tag's removal treats each column with a foreign key to `tags(id)`.
 * Deleting a tag is deliberate and removes it everywhere (PR #2378), so every
 * one is `clear` (ON DELETE CASCADE); this map exists for the undo of creating
 * a tag, which refuses while any row carries it (`findTagReferences`).
 *
 * Keyed `table.column`; `tag-references.spec.ts` parses `database/schema.sql`
 * and fails when this and the foreign keys disagree in either direction.
 */
export const TAG_REFERENCES = {
  "transaction_tags.tag_id": {
    policy: "clear",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transaction_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
    listSql:
      "SELECT g.id, count(*)::int AS count FROM transaction_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 GROUP BY g.id",
  },
  "transaction_split_tags.tag_id": {
    policy: "clear",
    kind: "transactions",
    sql: "SELECT count(*)::int AS count FROM transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
    listSql:
      "SELECT g.id, count(*)::int AS count FROM transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 GROUP BY g.id",
  },
  "scheduled_transaction_split_tags.tag_id": {
    policy: "clear",
    kind: "scheduledTransactions",
    sql: "SELECT count(*)::int AS count FROM scheduled_transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
    listSql:
      "SELECT g.id, count(*)::int AS count FROM scheduled_transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 GROUP BY g.id",
  },
  "security_tags.tag_id": {
    policy: "clear",
    kind: "securities",
    sql: "SELECT count(*)::int AS count FROM security_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
    listSql:
      "SELECT g.id, count(*)::int AS count FROM security_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 GROUP BY g.id",
  },
} as const satisfies Record<
  string,
  { policy: "clear"; kind: TagReferenceKind; sql: string; listSql: string }
>;

/**
 * Tag ids kept in JSON have no foreign key. shortcut: matches the id anywhere
 * in the JSON text; fine for UUIDs. `$2` is the LIKE pattern.
 */
const JSON_SQL: ReferenceCount[] = [
  {
    kind: "scheduledTransactions",
    sql: "SELECT count(*)::int AS count FROM scheduled_transactions WHERE user_id = $1 AND tag_ids::text LIKE $2",
    like: true,
  },
  {
    kind: "rules",
    sql: "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)",
    like: true,
  },
  {
    kind: "customReports",
    sql: "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND filters::text LIKE $2",
    like: true,
  },
];

/**
 * Every kind of row that still carries the tag, with a count above zero. For
 * the undo of a create, after locking the tag row; a delete does not use it.
 * Each count is scoped through the tag's owner (`$1` the user, `$2` the tag).
 */
export function findTagReferences(
  m: EntityManager,
  userId: string,
  tagId: string,
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  return countReferences(m, userId, tagId.toLowerCase(), [
    ...Object.values(TAG_REFERENCES),
    ...JSON_SQL,
  ]);
}

const JSON_LIST_SQL = [
  "SELECT g.id, count(*)::int AS count FROM scheduled_transactions s JOIN tags g ON g.user_id = s.user_id AND s.tag_ids::text LIKE '%' || g.id::text || '%' WHERE s.user_id = $1 GROUP BY g.id",
  "SELECT g.id, count(*)::int AS count FROM transaction_rules r JOIN tags g ON g.user_id = r.user_id AND (r.condition::text LIKE '%' || g.id::text || '%' OR r.actions::text LIKE '%' || g.id::text || '%') WHERE r.user_id = $1 GROUP BY g.id",
  "SELECT g.id, count(*)::int AS count FROM custom_reports r JOIN tags g ON g.user_id = r.user_id AND r.filters::text LIKE '%' || g.id::text || '%' WHERE r.user_id = $1 GROUP BY g.id",
];

/**
 * How many rows carry each of the user's tags, by the same references
 * `findTagReferences` counts (link tables, schedules' `tag_ids`, rules,
 * reports), so the list's count includes a tag used only on a schedule.
 */
export function countTagUsage(
  m: EntityManager,
  userId: string,
): Promise<Map<string, number>> {
  return countReferencesById(m, userId, [
    ...Object.values(TAG_REFERENCES).map((r) => r.listSql),
    ...JSON_LIST_SQL,
  ]);
}
