import { EntityManager } from "typeorm";
import { RecordInUseEntry } from "../common/helpers/record-in-use";

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
  "transaction_tags.tag_id": { policy: "clear", kind: "transactions" },
  "transaction_split_tags.tag_id": { policy: "clear", kind: "transactions" },
  "scheduled_transaction_split_tags.tag_id": {
    policy: "clear",
    kind: "scheduledTransactions",
  },
  "security_tags.tag_id": { policy: "clear", kind: "securities" },
} as const satisfies Record<
  string,
  { policy: "clear"; kind: TagReferenceKind }
>;

/** `$1` is the user, `$2` the tag; each scoped through the tag's owner. */
const COUNT_SQL: Record<string, string> = {
  "transaction_tags.tag_id":
    "SELECT count(*)::int AS count FROM transaction_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
  "transaction_split_tags.tag_id":
    "SELECT count(*)::int AS count FROM transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
  "scheduled_transaction_split_tags.tag_id":
    "SELECT count(*)::int AS count FROM scheduled_transaction_split_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
  "security_tags.tag_id":
    "SELECT count(*)::int AS count FROM security_tags x JOIN tags g ON g.id = x.tag_id WHERE g.user_id = $1 AND x.tag_id = $2",
};

/**
 * Tag ids kept in JSON have no foreign key. shortcut: matches the id anywhere
 * in the JSON text; fine for UUIDs. `$2` is the LIKE pattern.
 */
const JSON_SQL: [TagReferenceKind, string][] = [
  [
    "scheduledTransactions",
    "SELECT count(*)::int AS count FROM scheduled_transactions WHERE user_id = $1 AND tag_ids::text LIKE $2",
  ],
  [
    "rules",
    "SELECT count(*)::int AS count FROM transaction_rules WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)",
  ],
  [
    "customReports",
    "SELECT count(*)::int AS count FROM custom_reports WHERE user_id = $1 AND filters::text LIKE $2",
  ],
];

/**
 * Every kind of row that still carries the tag, with a count above zero. For
 * the undo of a create, after locking the tag row; a delete does not use it.
 */
export async function findTagReferences(
  m: EntityManager,
  userId: string,
  tagId: string,
): Promise<RecordInUseEntry[]> {
  // A UUID is valid in either case; JSON keeps it lowercase and LIKE is exact.
  tagId = tagId.toLowerCase();
  const counts = new Map<TagReferenceKind, number>();
  const add = async (kind: TagReferenceKind, sql: string, param: string) => {
    const rows: { count?: number }[] = await m.query(sql, [userId, param]);
    counts.set(kind, (counts.get(kind) ?? 0) + (Number(rows[0]?.count) || 0));
  };
  for (const [column, ref] of Object.entries(TAG_REFERENCES)) {
    await add(ref.kind, COUNT_SQL[column], tagId);
  }
  for (const [kind, sql] of JSON_SQL) await add(kind, sql, `%${tagId}%`);
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count }));
}
