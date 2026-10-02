import type { EntityManager } from "typeorm";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { ledgerMovementPredicate } from "../common/ledger-balance.sql";
import { DEFAULT_CUTOFF_LOOKBACK_DAYS } from "./bank-sync.constants";

/**
 * What linking a bank account to a Monize account would default its cut-off to
 * (spec section 7), and the fact the default follows.
 */
export interface LinkDefaults {
  /** The date of the newest non-VOID transaction in the account; null for an empty one. */
  newestTransactionDate: string | null;
  /** The cut-off a link made without a chosen date uses, `YYYY-MM-DD`. */
  defaultSyncFromDate: string;
}

/**
 * The cut-off default, and the one definition of it: the day after the newest
 * non-VOID transaction in the Monize account (capped at today), or today minus
 * `DEFAULT_CUTOFF_LOOKBACK_DAYS` for an empty one. `BankSyncService.linkAccount`
 * writes it and the link dialog's preview shows it, both through this function,
 * so the date the user is shown is the date the link gets.
 *
 * It reads in the caller's transaction (`m`), filtered by `userId`.
 */
export async function readLinkDefaults(
  m: EntityManager,
  userId: string,
  accountId: string,
  today: string = todayYMD(),
): Promise<LinkDefaults> {
  const rows: { newest: string | null }[] = await m.query(
    `SELECT TO_CHAR(MAX(t.transaction_date), 'YYYY-MM-DD') AS newest
       FROM transactions t
      WHERE t.account_id = $1
        AND t.user_id = $2
        AND ${ledgerMovementPredicate("t")}`,
    [accountId, userId],
  );
  const newest = rows[0]?.newest ?? null;
  if (newest === null) {
    return {
      newestTransactionDate: null,
      defaultSyncFromDate: addDaysYMD(today, -DEFAULT_CUTOFF_LOOKBACK_DAYS),
    };
  }
  const dayAfter = addDaysYMD(newest, 1);
  return {
    newestTransactionDate: newest,
    // A future-dated newest row must not push the cut-off past today: the bank's
    // booked rows up to now would all be "before the cut-off".
    defaultSyncFromDate: dayAfter > today ? today : dayAfter,
  };
}
