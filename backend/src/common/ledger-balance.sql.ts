/**
 * The one spelling of "what an account's balance is, as of a date".
 *
 * `balance(d) = opening_balance + SUM(amount)` over the account's non-VOID,
 * top-level transactions dated on or before `d` -- INV-BALANCE-001's source of
 * truth, and the expression `docs/specs/account-balances-as-of.md` section 3
 * defines the balances-as-of report by.
 *
 * It was written out four times (the current-balance recalculation, the
 * projected balance, the balances-as-of report, the balance forecast), and the
 * copies had already drifted -- two of them scope the join by `user_id` and two
 * do not. Nothing checked them against each other, so the next change to what
 * counts toward a balance would have landed on some copies and not others.
 *
 * That matters most for the scheduled loan bill (INV-LOAN-006): its whole claim
 * is that the debt it prices and the balance the report shows are *the same
 * measurement*, which is only true while the predicates agree. So the clauses
 * live here as data, and `ledger-balance-sql.spec.ts` scans `src/` for a
 * hand-written copy.
 */

/** A VOID row records something that did not happen, so it moved no money. */
export const LEDGER_EXCLUDES_VOID = `(t.status IS NULL OR t.status != 'VOID')`;

/** A split child is not a movement -- its parent already carries the total. */
export const LEDGER_TOP_LEVEL_ONLY = `t.parent_transaction_id IS NULL`;

/**
 * "Which rows are a movement of money" -- the pair above, as one conjunct.
 *
 * This is the fragment nearly every ledger read needs, and the one whose drift
 * actually costs something: a new status value, or a refinement of what a split
 * child means, has to reach every query at once or the balance, the forecast,
 * the statement cycle, the undo recalculation and the scheduled loan bill start
 * disagreeing about the same account. Not every caller sums a balance -- some
 * take MAX(date), some sum only future rows, some sum a CASE -- but they all
 * ask this same question first, so this is what is shared rather than a whole
 * query shape that only the balance reads would fit.
 *
 * Most callers alias the table `t`, which `LEDGER_MOVEMENT_PREDICATE` assumes;
 * a query that does not alias it at all passes `""`.
 * `ledger-balance-sql.spec.ts` fails a hand-written copy.
 */
export function ledgerMovementPredicate(alias = "t"): string {
  const col = alias ? `${alias}.` : "";
  return `((${col}status IS NULL OR ${col}status != 'VOID') AND ${col}parent_transaction_id IS NULL)`;
}

/** The `t`-aliased form, which is what nearly every ledger query uses. */
export const LEDGER_MOVEMENT_PREDICATE = ledgerMovementPredicate();

/**
 * The join a balance sums over, bounded at `asOfDateParam`.
 *
 * @param asOfDateParam the placeholder holding the as-of date (e.g. `"$2"`).
 * @param extra additional AND-ed join conditions (e.g. a `user_id` scope).
 */
export function ledgerBalanceJoin(
  asOfDateParam: string,
  extra: string[] = [],
): string {
  return [
    `LEFT JOIN transactions t ON t.account_id = a.id`,
    `  AND ${LEDGER_MOVEMENT_PREDICATE}`,
    ...extra.map((clause) => `  AND ${clause}`),
    `  AND t.transaction_date <= ${asOfDateParam}`,
  ].join("\n");
}

/** The summed expression itself, aliased as `balance`. */
export const LEDGER_BALANCE_EXPRESSION = `COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0)`;

/**
 * `LEDGER_BALANCE_EXPRESSION` as of `asOfDate`, over a `ledgerBalanceJoin`
 * bounded at that date or later: several balances of one account read in one
 * pass over its rows, each keeping only those on or before its own date.
 */
export function ledgerBalanceAsOfExpression(asOfDate: string): string {
  return `COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date <= ${asOfDate}), 0)`;
}

/**
 * A complete single-account as-of balance query: `$1` account, `$2` owner,
 * `$3` the as-of date.
 */
export const ACCOUNT_BALANCE_AS_OF_SQL = `SELECT ${LEDGER_BALANCE_EXPRESSION} AS balance
   FROM accounts a
   ${ledgerBalanceJoin("$3")}
  WHERE a.id = $1 AND a.user_id = $2
  GROUP BY a.id, a.opening_balance`;

/**
 * The same balance for several dates in one statement: `$1` account, `$2`
 * owner, `$3` a `date[]` of as-of dates, one row per date (`as_of` as
 * `YYYY-MM-DD`). Composed from the same join as `ACCOUNT_BALANCE_AS_OF_SQL`,
 * bounded at each unnested date, so the two cannot drift: the settlement of
 * several bank rows against a loan prices every slot of a pass off this
 * (`docs/specs/loan-installment-settlement.md` section 7.1), and
 * `datedLoanDebts` equals `datedLoanDebt` date by date because they are one
 * predicate.
 */
export const ACCOUNT_BALANCES_AS_OF_DATES_SQL = `SELECT TO_CHAR(d.as_of, 'YYYY-MM-DD') AS as_of,
        ${LEDGER_BALANCE_EXPRESSION} AS balance
   FROM accounts a
   CROSS JOIN unnest($3::date[]) AS d(as_of)
   ${ledgerBalanceJoin("d.as_of")}
  WHERE a.id = $1 AND a.user_id = $2
  GROUP BY a.id, a.opening_balance, d.as_of`;

/**
 * A provisional leg among the movements above: a transfer leg whose amount is
 * Monize's estimate until the other account's own file confirms it
 * (`docs/specs/provisional-amounts.md` section 4). It is the movement
 * predicate plus the column, so a VOID leg or a split child is never counted,
 * for the same reason neither moves a balance.
 *
 * The column is the only source (design P1); the description text is never
 * read here.
 */
export function ledgerProvisionalPredicate(alias = "t"): string {
  const col = alias ? `${alias}.` : "";
  return `(${ledgerMovementPredicate(alias)} AND ${col}amount_is_provisional)`;
}

/**
 * How many provisional legs each account's balance holds as of each date:
 * `$1` a `uuid[]` of account ids, `$2` a `date[]` of as-of dates, one row per
 * date and account that holds at least one (`as_of` as `YYYY-MM-DD`, `count`
 * as a bigint string). A leg counts toward a date when it is dated on or before
 * it, which is the bound `ledgerBalanceJoin` puts on the balance itself, so the
 * count is over exactly the provisional amounts inside that balance (design
 * section 6, "Figure shape"; P5). Every balance surface reads its count through
 * `loadProvisionalCounts` (`common/provisional-count.util.ts`).
 *
 * `$3` a date (or null for none) also bounds every date, for a balance that
 * is itself bounded there: the monthly snapshot sums no row dated after the
 * user's today (`NetWorthService.recalculateRegularAccount`), so a month's end
 * still ahead is the user's today, never the database's clock.
 *
 * The provisional rows are read once and then joined to the dates, so a month
 * grid of dates costs one pass over the account's (few) provisional legs.
 */
export const PROVISIONAL_COUNTS_AS_OF_DATES_SQL = `WITH legs AS (
     SELECT t.account_id, t.transaction_date
       FROM transactions t
      WHERE t.account_id = ANY($1::uuid[])
        AND ${ledgerProvisionalPredicate()}
        AND t.transaction_date <= (SELECT MAX(x) FROM unnest($2::date[]) AS x)
        AND ($3::date IS NULL OR t.transaction_date <= $3::date)
   )
   SELECT TO_CHAR(d.as_of, 'YYYY-MM-DD') AS as_of,
          legs.account_id AS account_id,
          COUNT(*) AS count
     FROM unnest($2::date[]) AS d(as_of)
     JOIN legs ON legs.transaction_date <= d.as_of
    GROUP BY d.as_of, legs.account_id`;
