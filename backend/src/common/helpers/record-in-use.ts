import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../../i18n/translate";

/**
 * One kind of row that still points at a record, for a refusal of the form
 * "this record is used elsewhere". `ids` names the rows when the client needs
 * them to link to the items (a loan account has its own page).
 */
export interface RecordInUseEntry {
  kind: string;
  count: number;
  ids?: string[];
}

export const RECORD_IN_USE_CODE = "RECORD_IN_USE";

/** "transactions (3), warranties (1)": each kind's label comes from `errors.recordInUse.kinds.<kind>`. */
export function recordInUseSummary(entries: RecordInUseEntry[]): string {
  return entries
    .map(
      ({ kind, count }) =>
        `${tr(`errors.recordInUse.kinds.${kind}`, kind)} (${count})`,
    )
    .join(", ");
}

/**
 * The 409 for a delete (or an undo of a create) that would clear or orphan
 * rows outside the record. `message` names the counts in words; `errors` lists
 * them for the client, which links each kind to where the items can be seen
 * (`HttpErrorBody` forwards `errorCode` and `errors`).
 */
export function recordInUseException(
  message: string,
  entries: RecordInUseEntry[],
): ConflictException {
  return new ConflictException({
    message,
    errorCode: RECORD_IN_USE_CODE,
    errors: entries,
  });
}

/**
 * One counting query for `countReferences`: `$1` is the user, `$2` the record
 * (or `%id%` when `like`, for an id kept inside JSON). `ids` means the query
 * returns the rows' `id`s, which are reported and counted; otherwise it
 * returns one `count`. `count` replaces the query where another helper counts.
 */
export type ReferenceCount = { kind: string } & (
  | { sql: string; ids?: boolean; like?: boolean }
  | { count: () => Promise<number> }
);

/** Sum each kind's counts, keep the kinds above zero, in the order first counted. */
export async function countReferences(
  m: EntityManager,
  userId: string,
  id: string,
  entries: readonly ReferenceCount[],
): Promise<RecordInUseEntry[]> {
  const found = new Map<string, RecordInUseEntry>();
  for (const e of entries) {
    let n: number;
    let ids: string[] | undefined;
    if ("count" in e) {
      n = await e.count();
    } else {
      const rows: { count?: number; id?: string }[] = await m.query(e.sql, [
        userId,
        e.like ? `%${id}%` : id,
      ]);
      ids = e.ids ? rows.map((r) => r.id as string) : undefined;
      n = ids ? ids.length : Number(rows[0]?.count) || 0;
    }
    if (n <= 0) continue;
    const entry = found.get(e.kind) ?? { kind: e.kind, count: 0 };
    entry.count += n;
    if (ids) entry.ids = [...(entry.ids ?? []), ...ids];
    found.set(e.kind, entry);
  }
  return [...found.values()];
}

/**
 * Per-record totals for a list: each `listSql` takes the user as `$1` and
 * returns `id` and `count` rows for that user's records; the counts are summed
 * per id. The grouped twin of `countReferences`, which counts one record.
 */
export async function countReferencesById(
  m: EntityManager,
  userId: string,
  listSqls: readonly string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const sql of listSqls) {
    const rows: { id: string; count: number }[] = await m.query(sql, [userId]);
    for (const r of rows) {
      totals.set(r.id, (totals.get(r.id) ?? 0) + Number(r.count));
    }
  }
  return totals;
}

/**
 * A kind counted from both sides: for one record (`sql`, what a delete or an
 * undo checks) and for all of a user's records at once (`listSql`, what a list
 * shows). Both live in one entry, so a kind cannot be added to one and missed
 * by the other.
 */
export type CountedReference = {
  kind: string;
  sql: string;
  listSql: string;
  ids?: boolean;
  like?: boolean;
};

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * `listSql` for an id kept inside JSON: the UUIDs are pulled out of each row's
 * text once, then joined to the user's `target` records on equality, so the
 * cost is rows plus records, not their product. A row counts once per record
 * however often it names it (what the per-record `LIKE` counts). Arguments are
 * SQL fragments written in this repository, never request input.
 */
export function jsonIdListSql(o: {
  /** FROM clause (may join) holding the JSON rows. */
  from: string;
  /** Unique id of the JSON row, so a row naming a record twice counts once. */
  rowId: string;
  /** The owning user column of the JSON rows. */
  userColumn: string;
  /** Text expression holding every JSON column that can name the record. */
  text: string;
  /** The records being counted: `categories`, `payees` or `tags`. */
  target: string;
}): string {
  return `SELECT t.id, count(DISTINCT x.row_id)::int AS count
    FROM (SELECT ${o.rowId} AS row_id, m.hit[1] AS ref
            FROM ${o.from},
                 LATERAL regexp_matches(lower(${o.text}), '${UUID_PATTERN}', 'g') AS m(hit)
           WHERE ${o.userColumn} = $1) x
    JOIN ${o.target} t ON t.user_id = $1 AND t.id::text = x.ref
   GROUP BY t.id`;
}

/** Rules keep ids in `condition` and `actions`. */
export const RULES_JSON = {
  from: "transaction_rules r",
  rowId: "r.id",
  userColumn: "r.user_id",
  text: "r.condition::text || ' ' || r.actions::text",
};
/** Custom reports keep ids in `filters`. */
export const REPORTS_JSON = {
  from: "custom_reports r",
  rowId: "r.id",
  userColumn: "r.user_id",
  text: "r.filters::text",
};
