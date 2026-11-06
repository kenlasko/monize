import { EntityManager } from "typeorm";
import { AccountType } from "./entities/account.entity";

/**
 * How many scheduled transactions each account's delete would destroy or
 * break (issue #2028), keyed by account id; an account no schedule names is
 * absent.
 *
 * A schedule counts once however many of its columns name the account:
 * - paid from it (`account_id`, ON DELETE CASCADE: the schedule goes);
 * - transferring into it (`transfer_account_id`, ON DELETE SET NULL: the
 *   transfer posts from then on as a plain uncategorized transaction);
 * - funding its investment from it (`investment_funding_account_id`, no
 *   action: the delete fails on the foreign key);
 * - with a split line transferring into it (the split's
 *   `transfer_account_id`, ON DELETE CASCADE: the line goes and the
 *   remaining lines no longer add up to the schedule's amount).
 *
 * A loan or mortgage's own payment schedule is left out: `AccountsService.delete`
 * removes it deliberately, together with the account.
 */
export async function countSchedulesReferencingAccounts(
  m: EntityManager,
  accountIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (accountIds.length === 0) return counts;

  const rows: Array<{ accountId: string; cnt: string | number }> =
    await m.query(
      `SELECT a.id AS "accountId", COUNT(DISTINCT st.id) AS "cnt"
       FROM accounts a
       JOIN scheduled_transactions st
         ON (st.account_id = a.id
             OR st.transfer_account_id = a.id
             OR st.investment_funding_account_id = a.id
             OR EXISTS (
               SELECT 1 FROM scheduled_transaction_splits sts
               WHERE sts.scheduled_transaction_id = st.id
                 AND sts.transfer_account_id = a.id))
        AND NOT (a.account_type = ANY($2)
                 AND st.id IS NOT DISTINCT FROM a.scheduled_transaction_id)
       WHERE a.id = ANY($1)
       GROUP BY a.id`,
      [accountIds, [AccountType.LOAN, AccountType.MORTGAGE]],
    );
  for (const row of rows) counts.set(row.accountId, Number(row.cnt));
  return counts;
}
