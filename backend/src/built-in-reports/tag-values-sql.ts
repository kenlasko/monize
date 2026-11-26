/**
 * SQL fragments that read the values of a row's own `K:*` tags, shared by every
 * built-in report that attributes or filters rows by a tag value
 * (`docs/specs/report-tag-key-breakdown.md` sections 1.1 and 11.4).
 */

/**
 * The transaction-level half of {@link tagValuesArrayExpr}, for a query that
 * never joins `transaction_splits` -- a whole (non-split) transfer has no
 * split-level tags to union in, and `t.is_transfer = true` rows are never
 * split parents (`transactions/transaction-analytics.service.ts`'s
 * `getTransfersByAccount` reads split transfer lines in a second query).
 */
export function transactionTagValuesArrayExpr(
  transactionAlias: string,
  keyParam: string,
): string {
  const t = transactionAlias;
  return `(
          SELECT ARRAY_AGG(DISTINCT tv_match.val) FROM (
            SELECT TRIM(SUBSTRING(tv_tg.name FROM POSITION(':' IN tv_tg.name) + 1)) AS val
              FROM transaction_tags tv_tt
              JOIN tags tv_tg ON tv_tg.id = tv_tt.tag_id
             WHERE tv_tt.transaction_id = ${t}.id
               AND POSITION(':' IN tv_tg.name) > 1
               AND LOWER(TRIM(SPLIT_PART(tv_tg.name, ':', 1))) = LOWER(${keyParam})
               AND TRIM(SUBSTRING(tv_tg.name FROM POSITION(':' IN tv_tg.name) + 1)) <> ''
          ) tv_match
        )`;
}

/**
 * The values of a row's own `K:*` tags, for the tag-key breakdown
 * (`docs/specs/report-tag-key-breakdown.md` section 1.1, rule B4).
 *
 * Mirrors the key/value parsing `buildTagKeyFilterClause`
 * (`transactions/tag-key-filter.util.ts`) and `getTransactionBreakdownByTagKey`
 * (`transactions/transaction-analytics.service.ts`) already use -- same
 * `POSITION(':' ...) > 1`, `SPLIT_PART(...,':',1)` key and trimmed-after-colon
 * value -- rewritten for a raw, positionally-parameterized query rather than a
 * TypeORM QueryBuilder's named parameters, which this report already uses and
 * `buildTagKeyFilterClause`'s `:param` binding cannot feed. Reads BOTH
 * `transaction_tags` (the whole transaction's own tags) and
 * `transaction_split_tags` (this split's own tags, when `splitAlias` names a
 * joined split); `UNION` (not `UNION ALL`) de-dupes a value present at both
 * levels so it attributes once (B4, I7). Returns SQL `NULL` when the row
 * carries no `K:*` tag for this key -- the caller decides what NULL means
 * (the reserved untagged bucket for a categorized row, "attributes to
 * nothing" for a transfer leg) rather than this expression choosing for both.
 */
export function tagValuesArrayExpr(
  transactionAlias: string,
  splitAlias: string,
  keyParam: string,
): string {
  const t = transactionAlias;
  const s = splitAlias;
  return `(
          SELECT ARRAY_AGG(DISTINCT tv_match.val) FROM (
            SELECT TRIM(SUBSTRING(tv_tg.name FROM POSITION(':' IN tv_tg.name) + 1)) AS val
              FROM transaction_tags tv_tt
              JOIN tags tv_tg ON tv_tg.id = tv_tt.tag_id
             WHERE tv_tt.transaction_id = ${t}.id
               AND POSITION(':' IN tv_tg.name) > 1
               AND LOWER(TRIM(SPLIT_PART(tv_tg.name, ':', 1))) = LOWER(${keyParam})
               AND TRIM(SUBSTRING(tv_tg.name FROM POSITION(':' IN tv_tg.name) + 1)) <> ''
            UNION
            SELECT TRIM(SUBSTRING(tv_stg.name FROM POSITION(':' IN tv_stg.name) + 1)) AS val
              FROM transaction_split_tags tv_tst
              JOIN tags tv_stg ON tv_stg.id = tv_tst.tag_id
             WHERE ${s}.id IS NOT NULL
               AND tv_tst.transaction_split_id = ${s}.id
               AND POSITION(':' IN tv_stg.name) > 1
               AND LOWER(TRIM(SPLIT_PART(tv_stg.name, ':', 1))) = LOWER(${keyParam})
               AND TRIM(SUBSTRING(tv_stg.name FROM POSITION(':' IN tv_stg.name) + 1)) <> ''
          ) tv_match
        )`;
}
