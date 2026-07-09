import { escapeLikePattern } from "./transaction-search.util";

/**
 * Filtering transactions by a KEY:VALUE tag key (see
 * `tags/tag-key-value.util.ts` for the naming convention).
 *
 * A transaction matches when the transaction itself OR any of its splits
 * carries a tag under the given key that satisfies the operator:
 * - `hasValue`     -- has a `key:<non-empty>` tag.
 * - `noValue`      -- has NO `key:<non-empty>` tag (the key is unset for it).
 * - `contains`     -- has a `key:<value>` tag whose value contains the term.
 * - `notContains`  -- has NO `key:<value>` tag whose value contains the term.
 *
 * The clause is fully parameterized -- the key and the (LIKE-escaped) term are
 * bound, never interpolated. Values are parsed in SQL to match the JS parser:
 * key = text before the first colon (trimmed, non-empty), value = text after
 * (trimmed). Split subqueries key on `transaction.id` only, so the clause is
 * safe to reuse in aggregating queries without inflating row counts.
 */
export type TagKeyFilterOp =
  | "hasValue"
  | "noValue"
  | "contains"
  | "notContains";

export interface TagKeyFilter {
  /** The tag key to filter on (e.g. "country"). */
  key: string;
  op: TagKeyFilterOp;
  /** Substring term, required for `contains` / `notContains`. */
  value?: string;
}

export function buildTagKeyFilterClause(
  transactionAlias: string,
  filter: TagKeyFilter,
  paramPrefix = "tkf",
): { clause: string; params: Record<string, unknown> } {
  const t = transactionAlias;
  const p = paramPrefix;
  const params: Record<string, unknown> = { [`${p}Key`]: filter.key.trim() };

  // Text after the first colon, trimmed -- the KEY:VALUE "value".
  const valueExpr = (n: string) =>
    `TRIM(SUBSTRING(${n} FROM POSITION(':' IN ${n}) + 1))`;
  // The tag's key (text before the first colon, trimmed) equals the filter key.
  // POSITION(':' ...) > 1 guarantees a non-empty key before the colon.
  const keyMatch = (n: string) =>
    `POSITION(':' IN ${n}) > 1 AND LOWER(TRIM(SPLIT_PART(${n}, ':', 1))) = LOWER(:${p}Key)`;

  let valueCond: (n: string) => string;
  if (filter.op === "contains" || filter.op === "notContains") {
    params[`${p}Val`] = `%${escapeLikePattern((filter.value ?? "").trim())}%`;
    valueCond = (n) => `LOWER(${valueExpr(n)}) LIKE LOWER(:${p}Val)`;
  } else {
    // hasValue / noValue -> the key carries a non-empty value.
    valueCond = (n) => `${valueExpr(n)} <> ''`;
  }

  const txExists =
    `EXISTS (SELECT 1 FROM transaction_tags ${p}_tt ` +
    `JOIN tags ${p}_tg ON ${p}_tg.id = ${p}_tt.tag_id ` +
    `WHERE ${p}_tt.transaction_id = ${t}.id ` +
    `AND ${keyMatch(`${p}_tg.name`)} AND ${valueCond(`${p}_tg.name`)})`;

  const splitExists =
    `EXISTS (SELECT 1 FROM transaction_splits ${p}_ts ` +
    `JOIN transaction_split_tags ${p}_tst ON ${p}_tst.transaction_split_id = ${p}_ts.id ` +
    `JOIN tags ${p}_stg ON ${p}_stg.id = ${p}_tst.tag_id ` +
    `WHERE ${p}_ts.transaction_id = ${t}.id ` +
    `AND ${keyMatch(`${p}_stg.name`)} AND ${valueCond(`${p}_stg.name`)})`;

  const anyMatch = `(${txExists} OR ${splitExists})`;
  const negate = filter.op === "noValue" || filter.op === "notContains";
  return { clause: negate ? `NOT ${anyMatch}` : anyMatch, params };
}

/** True when the op requires a `value` term. */
export function tagKeyOpNeedsValue(op: TagKeyFilterOp): boolean {
  return op === "contains" || op === "notContains";
}

export const TAG_KEY_FILTER_OPS: readonly TagKeyFilterOp[] = [
  "hasValue",
  "noValue",
  "contains",
  "notContains",
];
