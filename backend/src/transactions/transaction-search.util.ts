import { primaryAttachmentSql } from "../attachments/primary-attachment.util";
import { attachmentReachableFromTransactionSql } from "../attachments/attachment-parent";
import {
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
} from "../common/investment-filter.util";
import type { SearchTerm } from "./transaction-search-query.util";

/**
 * The SQL of the Transactions search (docs/specs/advanced-search.md).
 *
 * `buildTransactionSearchWhere` turns parsed terms into one WHERE condition.
 * A bare term matches across every user-visible field -- payee, category,
 * amount, description, reference number, split memo, tag -- and a qualified
 * term reads only its own field. Relational fields are matched through
 * EXISTS subqueries, so a caller that aggregates (SUM/COUNT) never gets
 * inflated rows from extra joins.
 *
 * A search surface never builds the clause itself: `applyTransactionSearch`
 * is the one door (INV-SEARCH-001), and a search string is escaped here,
 * once.
 */

/** Escapes LIKE metacharacters; shared with the tag-key filter and email receipts. */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * The row a search term is evaluated against (plan section 4.4).
 *
 * - `transaction`: a split field matches when ANY of the transaction's
 *   splits matches, independently per term, so two terms can be satisfied by
 *   different splits and a negated term excludes the transaction if any
 *   split matches.
 * - `split`: the query's rows are split lines (a split joined under
 *   `splits`); a split field reads that row's split only, as the joined-alias
 *   clause always has.
 */
export type SearchGrain = "transaction" | "split";

export interface SearchClauseOptions {
  /** Alias of the parent transaction in the surrounding query. */
  transaction: string;
  /** Alias of the joined split; required at `split` grain. */
  splits?: string;
  grain: SearchGrain;
  /** Prefix of every bound parameter; unique per call within one query. */
  paramPrefix: string;
}

export interface SearchClause {
  sql: string;
  params: Record<string, unknown>;
}

/** The alias each split subquery binds its `transaction_splits` row to. */
const SPLIT_ROW = "search_sx";

/**
 * A reference number normalised for an exact match (plan section 4.3):
 * trimmed, lower-cased, one leading `#` dropped, and leading zeros dropped
 * from an all-digit value (keeping a single `0`). `referenceKeySql` is the
 * same function in SQL; the integration spec pins the two equal.
 */
export function referenceKey(value: string): string {
  let key = value.trim().toLowerCase();
  if (key.startsWith("#")) key = key.slice(1);
  if (/^[0-9]+$/.test(key)) key = key.replace(/^0+/, "") || "0";
  return key;
}

export function referenceKeySql(column: string): string {
  const stripped = `regexp_replace(lower(btrim(${column})), '^#', '')`;
  return (
    `(CASE WHEN ${stripped} ~ '^[0-9]+$' ` +
    `THEN COALESCE(NULLIF(ltrim(${stripped}, '0'), ''), '0') ` +
    `ELSE ${stripped} END)`
  );
}

/** Turns a `*` glob into an anchored ILIKE pattern, escaping everything else. */
function globPattern(value: string): string {
  return value.split("*").map(escapeLikePattern).join("%");
}

/** Builds the SQL of one search; `next` names its parameters. */
class ClauseContext {
  readonly params: Record<string, unknown> = {};
  private counter = 0;

  constructor(readonly options: SearchClauseOptions) {
    if (options.grain === "split" && !options.splits) {
      throw new Error("A split-grain search needs the joined split alias");
    }
  }

  get t(): string {
    return this.options.transaction;
  }

  bind(value: unknown): string {
    const name = `${this.options.paramPrefix}${this.counter}`;
    this.counter += 1;
    this.params[name] = value;
    return `:${name}`;
  }

  splitExists(conditions: string[]): string | null {
    return splitExistsSql(this.options, conditions);
  }
}

/**
 * One subquery over the split rows the grain allows, holding every split
 * condition of a term (written against `search_sx`), so a term never
 * inflates an aggregate. Null when there are no conditions.
 */
export function splitExistsSql(
  options: Pick<SearchClauseOptions, "transaction" | "splits" | "grain">,
  conditions: string[],
): string | null {
  if (conditions.length === 0) return null;
  const correlation =
    options.grain === "transaction"
      ? `${SPLIT_ROW}.transaction_id = ${options.transaction}.id`
      : `${SPLIT_ROW}.id = ${options.splits}.id`;
  return `EXISTS (SELECT 1 FROM transaction_splits ${SPLIT_ROW} WHERE ${correlation} AND (${conditions.join(" OR ")}))`;
}

/**
 * A text matcher: given a column expression, the condition the term's op
 * puts on it. Each one binds its own parameter once and reuses it.
 */
type TextMatch = (column: string) => string;

function textMatch(ctx: ClauseContext, term: SearchTerm): TextMatch {
  if (term.op === "exact") {
    const param = ctx.bind(escapeLikePattern(term.value.trim()));
    return (column) => `btrim(${column}) ILIKE ${param}`;
  }
  if (term.op === "glob") {
    const param = ctx.bind(globPattern(term.value));
    return (column) => `${column} ILIKE ${param}`;
  }
  const param = ctx.bind(`%${escapeLikePattern(term.value)}%`);
  return (column) => `${column} ILIKE ${param}`;
}

/** Joins arms into one condition; split arms go through one subquery. */
function anyOf(
  ctx: ClauseContext,
  rowArms: string[],
  splitArms: string[],
): string {
  const arms = [...rowArms];
  const splits = ctx.splitExists(splitArms);
  if (splits) arms.push(splits);
  return arms.length === 1 ? arms[0] : `(${arms.join(" OR ")})`;
}

// The arm partition of plan section 4.2. Each is a function of the matcher
// so contains, exact and glob share one list of columns.

function payeeArms(ctx: ClauseContext, match: TextMatch): string {
  const t = ctx.t;
  return anyOf(
    ctx,
    [
      match(`${t}.payeeName`),
      `EXISTS (SELECT 1 FROM payees search_p WHERE search_p.id = ${t}.payee_id AND ${match("search_p.name")})`,
      // A transfer leg with a blank payee displays "Transfer to/from
      // <counterpart>" (issue #1214), so the counterpart account's name is
      // payee text. Restricted to transfer legs, as in the clause above.
      `EXISTS (SELECT 1 FROM transactions search_lt JOIN accounts search_la ON search_la.id = search_lt.account_id WHERE search_lt.id = ${t}.linked_transaction_id AND ${t}.is_transfer = true AND ${match("search_la.name")})`,
    ],
    [],
  );
}

function memoArms(ctx: ClauseContext, match: TextMatch): string {
  return anyOf(
    ctx,
    [match(`${ctx.t}.description`)],
    [match(`${SPLIT_ROW}.memo`)],
  );
}

function categoryArms(ctx: ClauseContext, match: TextMatch): string {
  return anyOf(
    ctx,
    [
      `EXISTS (SELECT 1 FROM categories search_c WHERE search_c.id = ${ctx.t}.category_id AND ${match("search_c.name")})`,
    ],
    [
      `EXISTS (SELECT 1 FROM categories search_sc WHERE search_sc.id = ${SPLIT_ROW}.category_id AND ${match("search_sc.name")})`,
    ],
  );
}

function tagArms(ctx: ClauseContext, match: TextMatch): string {
  return anyOf(
    ctx,
    [
      `EXISTS (SELECT 1 FROM transaction_tags search_tt JOIN tags search_tg ON search_tg.id = search_tt.tag_id WHERE search_tt.transaction_id = ${ctx.t}.id AND ${match("search_tg.name")})`,
    ],
    [
      `EXISTS (SELECT 1 FROM transaction_split_tags search_stt JOIN tags search_stg ON search_stg.id = search_stt.tag_id WHERE search_stt.transaction_split_id = ${SPLIT_ROW}.id AND ${match("search_stg.name")})`,
    ],
  );
}

function accountArms(ctx: ClauseContext, match: TextMatch): string {
  return `EXISTS (SELECT 1 FROM accounts search_a WHERE search_a.id = ${ctx.t}.account_id AND ${match("search_a.name")})`;
}

function referenceCondition(ctx: ClauseContext, term: SearchTerm): string {
  const column = `${ctx.t}.referenceNumber`;
  if (term.op === "exact") {
    return `${referenceKeySql(column)} = ${ctx.bind(referenceKey(term.value))}`;
  }
  return textMatch(ctx, term)(column);
}

/** Today's single-term clause, per bare term (INV-SEARCH-002). */
function anyCondition(ctx: ClauseContext, term: SearchTerm): string {
  const t = ctx.t;
  const s = SPLIT_ROW;
  const p = ctx.bind(`%${escapeLikePattern(term.value.trim())}%`);
  const rowArms = [
    `${t}.description ILIKE ${p}`,
    `${t}.payeeName ILIKE ${p}`,
    `${t}.referenceNumber ILIKE ${p}`,
    `CAST(${t}.amount AS TEXT) ILIKE ${p}`,
  ];
  const splitArms = [
    `${s}.memo ILIKE ${p}`,
    `CAST(${s}.amount AS TEXT) ILIKE ${p}`,
  ];

  const amount = term.interpreted?.amount ?? null;
  if (amount !== null) {
    // Absolute value, so a pasted statement figure finds either sign.
    const ap = ctx.bind(Math.abs(amount));
    rowArms.push(`ABS(${t}.amount) = CAST(${ap} AS numeric)`);
    splitArms.push(`ABS(${s}.amount) = CAST(${ap} AS numeric)`);
  }
  const date = term.interpreted?.date ?? null;
  if (date !== null) {
    rowArms.push(`${t}.transactionDate = CAST(${ctx.bind(date)} AS date)`);
  }

  rowArms.push(
    `EXISTS (SELECT 1 FROM payees search_p WHERE search_p.id = ${t}.payee_id AND search_p.name ILIKE ${p})`,
    `EXISTS (SELECT 1 FROM transactions search_lt JOIN accounts search_la ON search_la.id = search_lt.account_id WHERE search_lt.id = ${t}.linked_transaction_id AND ${t}.is_transfer = true AND search_la.name ILIKE ${p})`,
    `EXISTS (SELECT 1 FROM categories search_c WHERE search_c.id = ${t}.category_id AND search_c.name ILIKE ${p})`,
    `EXISTS (SELECT 1 FROM transaction_tags search_tt JOIN tags search_tg ON search_tg.id = search_tt.tag_id WHERE search_tt.transaction_id = ${t}.id AND search_tg.name ILIKE ${p})`,
  );
  splitArms.push(
    `EXISTS (SELECT 1 FROM categories search_sc WHERE search_sc.id = ${s}.category_id AND search_sc.name ILIKE ${p})`,
    `EXISTS (SELECT 1 FROM transaction_split_tags search_stt JOIN tags search_stg ON search_stg.id = search_stt.tag_id WHERE search_stt.transaction_split_id = ${s}.id AND search_stg.name ILIKE ${p})`,
  );
  return anyOf(ctx, rowArms, splitArms);
}

const STATUS_VALUES: Readonly<Record<string, string>> = {
  cleared: "CLEARED",
  reconciled: "RECONCILED",
  unreconciled: "UNRECONCILED",
  void: "VOID",
};

/**
 * A transaction with no category: an ordinary row with none, or a split with
 * a non-transfer line with none. Investment-linked rows and lines are never
 * uncategorised. The category filter's `uncategorized` pseudo-id states the
 * same predicate inline in three services; folding those onto this one is a
 * follow-up recorded in the plan's scope cuts, not part of the search work.
 */
export function uncategorizedSql(
  options: Pick<SearchClauseOptions, "transaction" | "splits" | "grain">,
): string {
  const t = options.transaction;
  const splitLine = splitExistsSql(options, [
    `(${SPLIT_ROW}.category_id IS NULL AND ${SPLIT_ROW}.transfer_account_id IS NULL AND ${investmentLinkedSplitExclusion(SPLIT_ROW)})`,
  ]);
  return (
    `((${t}.category_id IS NULL AND ${t}.is_split = false AND ${t}.is_transfer = false AND ${investmentLinkedTransactionExclusion(t)})` +
    ` OR (${t}.is_split = true AND ${t}.is_transfer = false AND ${splitLine}))`
  );
}

/**
 * A transaction with at least one primary attachment: its own, or a document
 * of a warranty linked to it (`attachmentReachableFromTransactionSql`).
 */
export function hasAttachmentSql(transactionAlias: string): string {
  return `EXISTS (SELECT 1 FROM transaction_attachments search_ta WHERE ${attachmentReachableFromTransactionSql("search_ta", `${transactionAlias}.id`)} AND ${primaryAttachmentSql("search_ta")})`;
}

/**
 * A transaction with at least one unarchived warranty linked to it; the
 * register's `warrantyCount` counts the same rows.
 */
export function hasWarrantySql(transactionAlias: string): string {
  return `EXISTS (SELECT 1 FROM warranties search_w WHERE search_w.transaction_id = ${transactionAlias}.id AND search_w.archived_at IS NULL)`;
}

function enumCondition(ctx: ClauseContext, term: SearchTerm): string {
  const t = ctx.t;
  if (term.field === "status") {
    return `${t}.status = ${ctx.bind(STATUS_VALUES[term.value])}`;
  }
  if (term.field === "is") {
    if (term.value === "transfer") return `${t}.is_transfer = true`;
    if (term.value === "split") return `${t}.is_split = true`;
    if (term.value === "provisional") {
      return `${t}.amount_is_provisional = true`;
    }
    return uncategorizedSql(ctx.options);
  }
  switch (term.value) {
    case "attachment":
      return hasAttachmentSql(t);
    case "warranty":
      return hasWarrantySql(t);
    case "ref":
      return `NULLIF(btrim(${t}.referenceNumber), '') IS NOT NULL`;
    case "memo":
      return anyOf(
        ctx,
        [`NULLIF(btrim(${t}.description), '') IS NOT NULL`],
        [`NULLIF(btrim(${SPLIT_ROW}.memo), '') IS NOT NULL`],
      );
    default:
      return anyOf(
        ctx,
        [
          `EXISTS (SELECT 1 FROM transaction_tags search_tt WHERE search_tt.transaction_id = ${t}.id)`,
        ],
        [
          `EXISTS (SELECT 1 FROM transaction_split_tags search_stt WHERE search_stt.transaction_split_id = ${SPLIT_ROW}.id)`,
        ],
      );
  }
}

const COMPARATORS: Readonly<Record<string, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * Amount and date. An amount's equality reads the total and the split
 * lines; every comparison reads the total only (plan decision 8). Both
 * compare magnitude.
 */
function valueCondition(ctx: ClauseContext, term: SearchTerm): string {
  const t = ctx.t;
  const isAmount = term.field === "amount";
  const cast = isAmount ? "numeric" : "date";
  const column = isAmount ? `ABS(${t}.amount)` : `${t}.transactionDate`;
  const value = (v: string) =>
    `CAST(${ctx.bind(isAmount ? Number(v) : v)} AS ${cast})`;

  if (term.op === "eq") {
    const target = value(term.value);
    if (!isAmount) return `${column} = ${target}`;
    return anyOf(
      ctx,
      [`${column} = ${target}`],
      [`ABS(${SPLIT_ROW}.amount) = ${target}`],
    );
  }
  if (term.op === "between") {
    return `${column} BETWEEN ${value(term.value)} AND ${value(term.valueTo as string)}`;
  }
  return `${column} ${COMPARATORS[term.op]} ${value(term.value)}`;
}

function termCondition(ctx: ClauseContext, term: SearchTerm): string {
  switch (term.field) {
    case "any":
      return anyCondition(ctx, term);
    case "payee":
      return payeeArms(ctx, textMatch(ctx, term));
    case "memo":
      return memoArms(ctx, textMatch(ctx, term));
    case "cat":
      return categoryArms(ctx, textMatch(ctx, term));
    case "tag":
      return tagArms(ctx, textMatch(ctx, term));
    case "account":
      return accountArms(ctx, textMatch(ctx, term));
    case "ref":
      return referenceCondition(ctx, term);
    case "status":
    case "is":
    case "has":
      return enumCondition(ctx, term);
    default:
      return valueCondition(ctx, term);
  }
}

/**
 * The WHERE condition of a parsed search: every applicable term AND-ed.
 * Each term is wrapped in `COALESCE(..., FALSE)` before any `NOT`, so a
 * null column (no description, no split on a left join) reads as "no match"
 * and a negated term keeps the row instead of dropping it as unknown.
 * Returns null when no term applies (a blank string, or only empty terms).
 */
export function buildTransactionSearchWhere(
  terms: readonly SearchTerm[],
  options: SearchClauseOptions,
): SearchClause | null {
  const ctx = new ClauseContext(options);
  const conditions = terms
    .filter((term) => term.ignored !== "empty")
    .map((term) => {
      const condition = `COALESCE(${termCondition(ctx, term)}, FALSE)`;
      return term.negated ? `NOT ${condition}` : condition;
    });
  if (conditions.length === 0) return null;
  return { sql: `(${conditions.join(" AND ")})`, params: ctx.params };
}
