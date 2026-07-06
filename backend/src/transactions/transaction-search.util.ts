/**
 * Builds the WHERE clause used by the Transactions filter "Search" box.
 *
 * The search term is matched against many fields so users can find a
 * transaction by typing whatever they remember about it: payee, category,
 * subcategory (parent or child category name), amount, description,
 * reference number, split memo, or tag.
 *
 * Relational fields (payee, category, tag) are matched via EXISTS subqueries
 * so callers that aggregate (SUM/COUNT) won't get inflated row counts from
 * extra joins.
 */
export interface TransactionSearchAliases {
  /** Alias of the parent transaction in the surrounding query (e.g. "transaction", "t", "bf"). */
  transaction: string;
  /** Alias of the joined transaction_splits relation (e.g. "splits", "s", "bfSplits"). */
  splits: string;
  /** Bound parameter name (default: "search"). The caller binds `%pattern%` to this. */
  paramName?: string;
  /**
   * Bound parameter name for the interpreted exact amount (default:
   * `${paramName}Amount`). The caller ALWAYS binds it -- the parsed amount, or
   * null when the term did not parse as a number. When non-null the clause
   * additionally matches rows whose absolute amount equals it exactly.
   */
  amountParamName?: string;
  /**
   * Bound parameter name for the interpreted exact date (default:
   * `${paramName}Date`). The caller ALWAYS binds it -- the parsed ISO date, or
   * null. When non-null the clause additionally matches rows on that
   * transaction date exactly.
   */
  dateParamName?: string;
}

export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function buildTransactionSearchClause(
  aliases: TransactionSearchAliases,
): string {
  const t = aliases.transaction;
  const s = aliases.splits;
  const p = aliases.paramName ?? "search";
  const ap = aliases.amountParamName ?? `${p}Amount`;
  const dp = aliases.dateParamName ?? `${p}Date`;

  // The amount/date params are ALWAYS bound by callers (null when the term did
  // not parse). They are cast so the null bind type-checks in Postgres, and
  // guarded so the extra predicates are inert unless the term parsed. This
  // keeps the original substring behaviour as the base and OR-s the
  // interpreted matches on top of it. Absolute value on the amount lets a
  // pasted statement figure find both the debit and credit legs.
  return (
    `(${t}.description ILIKE :${p}` +
    ` OR ${t}.payeeName ILIKE :${p}` +
    ` OR ${t}.referenceNumber ILIKE :${p}` +
    ` OR ${s}.memo ILIKE :${p}` +
    ` OR CAST(${t}.amount AS TEXT) ILIKE :${p}` +
    ` OR CAST(${s}.amount AS TEXT) ILIKE :${p}` +
    ` OR (CAST(:${ap} AS numeric) IS NOT NULL AND ABS(${t}.amount) = ABS(CAST(:${ap} AS numeric)))` +
    ` OR (CAST(:${ap} AS numeric) IS NOT NULL AND ABS(${s}.amount) = ABS(CAST(:${ap} AS numeric)))` +
    ` OR (CAST(:${dp} AS date) IS NOT NULL AND ${t}.transactionDate = CAST(:${dp} AS date))` +
    ` OR EXISTS (SELECT 1 FROM payees search_p WHERE search_p.id = ${t}.payee_id AND search_p.name ILIKE :${p})` +
    ` OR EXISTS (SELECT 1 FROM categories search_c WHERE search_c.id = ${t}.category_id AND search_c.name ILIKE :${p})` +
    ` OR EXISTS (SELECT 1 FROM categories search_sc WHERE search_sc.id = ${s}.category_id AND search_sc.name ILIKE :${p})` +
    ` OR EXISTS (SELECT 1 FROM transaction_tags search_tt JOIN tags search_tg ON search_tg.id = search_tt.tag_id WHERE search_tt.transaction_id = ${t}.id AND search_tg.name ILIKE :${p})` +
    ` OR EXISTS (SELECT 1 FROM transaction_split_tags search_stt JOIN tags search_stg ON search_stg.id = search_stt.tag_id WHERE search_stt.transaction_split_id = ${s}.id AND search_stg.name ILIKE :${p})` +
    `)`
  );
}
