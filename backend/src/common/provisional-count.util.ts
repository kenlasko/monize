import { EntityManager } from "typeorm";

import { PROVISIONAL_COUNTS_AS_OF_DATES_SQL } from "./ledger-balance.sql";

/**
 * The provisional legs inside account balances, by account and as-of date
 * (`docs/specs/provisional-amounts.md` section 6, "Figure shape"; P5).
 *
 * A balance surface (the account list, the balances-as-of report, the daily
 * totals, the net worth months) reads its count from here and never writes its
 * own predicate: the rule for which rows count -- non-VOID, top level, flagged,
 * dated on or before the balance's day -- is `ledgerProvisionalPredicate`, and
 * `ledger-balance-sql.spec.ts` fails a balance-family file that names the
 * column itself.
 *
 * A count is a number of rows, never money, and adds no figure: no balance
 * changes and none is withheld because of it.
 */
export class ProvisionalCounts {
  private constructor(
    private readonly byDate: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ) {}

  /** Nothing counted: no account, no date, or no provisional leg at all. */
  static readonly NONE = new ProvisionalCounts(new Map());

  static fromRows(
    rows: ReadonlyArray<{ as_of: string; account_id: string; count: unknown }>,
  ): ProvisionalCounts {
    const byDate = new Map<string, Map<string, number>>();
    for (const row of rows) {
      let accounts = byDate.get(row.as_of);
      if (!accounts) {
        accounts = new Map();
        byDate.set(row.as_of, accounts);
      }
      accounts.set(row.account_id, Number(row.count));
    }
    return new ProvisionalCounts(byDate);
  }

  /** The counts of several reads over disjoint accounts, as one. */
  static merged(parts: ReadonlyArray<ProvisionalCounts>): ProvisionalCounts {
    const byDate = new Map<string, Map<string, number>>();
    for (const part of parts) {
      for (const [asOf, accounts] of part.byDate) {
        const into = byDate.get(asOf) ?? new Map<string, number>();
        for (const [accountId, count] of accounts) into.set(accountId, count);
        byDate.set(asOf, into);
      }
    }
    return new ProvisionalCounts(byDate);
  }

  /** The provisional legs inside `accountId`'s balance as of `asOf`. */
  of(accountId: string, asOf: string): number {
    return this.byDate.get(asOf)?.get(accountId) ?? 0;
  }
}

/**
 * Read the counts for `accountIds` at each of `asOfDates` (`YYYY-MM-DD`) in
 * one statement, inside the caller's scoped transaction.
 *
 * `notAfter` (YYYY-MM-DD) bounds every date at that day as well, for a balance
 * bounded at the user's today (the monthly net worth snapshot); the result is still keyed by the dates asked for.
 */
export async function loadProvisionalCounts(
  m: EntityManager,
  accountIds: ReadonlyArray<string>,
  asOfDates: ReadonlyArray<string>,
  options: { notAfter?: string | null } = {},
): Promise<ProvisionalCounts> {
  if (accountIds.length === 0 || asOfDates.length === 0) {
    return ProvisionalCounts.NONE;
  }
  const rows: Array<{ as_of: string; account_id: string; count: string }> =
    await m.query(PROVISIONAL_COUNTS_AS_OF_DATES_SQL, [
      [...new Set(accountIds)],
      [...new Set(asOfDates)],
      options.notAfter ?? null,
    ]);
  return ProvisionalCounts.fromRows(rows);
}
