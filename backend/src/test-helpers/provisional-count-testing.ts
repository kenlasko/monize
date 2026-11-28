import { PROVISIONAL_COUNTS_AS_OF_DATES_SQL } from "../common/ledger-balance.sql";

/**
 * A provisional leg as the count query sees it: one that already passed
 * `ledgerProvisionalPredicate` (flagged, non-VOID, top level). Which rows pass
 * that predicate is the SQL's claim, proven against PostgreSQL in
 * `test/integration/provisional-count.integration.spec.ts`; a unit spec only
 * says which legs exist and when they are dated.
 */
export interface ProvisionalLegFixture {
  account_id: string;
  transaction_date: string;
}

/** Whether a mocked `query` call is the provisional count read. */
export const isProvisionalCountQuery = (sql: string): boolean =>
  sql === PROVISIONAL_COUNTS_AS_OF_DATES_SQL;

/**
 * What `PROVISIONAL_COUNTS_AS_OF_DATES_SQL` returns for `legs`, given the
 * statement's own parameters (`$1` account ids, `$2` as-of dates, `$3` the
 * day to bound them at, or null): per
 * date and account, the legs dated on or before the date. Simulating the query
 * rather than handing back counts keeps a fixture honest about the as-of rule.
 */
export function provisionalCountRows(
  legs: ReadonlyArray<ProvisionalLegFixture>,
  params: unknown[],
): Array<{ as_of: string; account_id: string; count: string }> {
  const [accountIds, asOfDates, notAfter] = params as [
    string[],
    string[],
    string | null | undefined,
  ];
  const rows: Array<{ as_of: string; account_id: string; count: string }> = [];
  for (const asOf of asOfDates) {
    const bound = notAfter != null && notAfter < asOf ? notAfter : asOf;
    for (const accountId of accountIds) {
      const count = legs.filter(
        (leg) => leg.account_id === accountId && leg.transaction_date <= bound,
      ).length;
      if (count > 0) {
        rows.push({ as_of: asOf, account_id: accountId, count: String(count) });
      }
    }
  }
  return rows;
}
