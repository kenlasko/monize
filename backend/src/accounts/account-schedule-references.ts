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
 *   remaining lines no longer add up to the schedule's amount);
 * - with a pending split override whose line transfers into it
 *   (`scheduled_transaction_overrides.splits[].transferAccountId`, JSONB with
 *   no foreign key: the override would post a leg into a missing account).
 *   Matched case-insensitively, since a UUID is valid in either case. An
 *   override of a slot before the schedule's `next_due_date` is spent, and one
 *   with `is_split` false never posts its `splits`, so neither counts. A NULL
 *   `is_split` follows the schedule's own, which can be switched on later, so
 *   it counts.
 *
 * A loan or mortgage's own payment schedule is left out: `AccountsService.delete`
 * removes it deliberately, in the same transaction as the account.
 *
 * Each reference is its own lookup, unioned, so the account list, which asks
 * this for every account, never pairs every account with every schedule. The
 * `account_id`, `transfer_account_id` and split lookups use their indexes;
 * `investment_funding_account_id` has no index and is scanned, and the
 * override branch reads the JSONB of pending overrides only.
 */
export async function countSchedulesReferencingAccounts(
  m: EntityManager,
  accountIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (accountIds.length === 0) return counts;

  const rows: Array<{ accountId: string; cnt: string | number }> =
    await m.query(
      `WITH ids AS (SELECT unnest($1::uuid[]) AS id),
       refs AS (
         SELECT st.id AS schedule_id, st.account_id AS account_id
         FROM scheduled_transactions st JOIN ids ON st.account_id = ids.id
         UNION ALL
         SELECT st.id, st.transfer_account_id
         FROM scheduled_transactions st JOIN ids ON st.transfer_account_id = ids.id
         UNION ALL
         SELECT st.id, st.investment_funding_account_id
         FROM scheduled_transactions st
         JOIN ids ON st.investment_funding_account_id = ids.id
         UNION ALL
         SELECT sts.scheduled_transaction_id, sts.transfer_account_id
         FROM scheduled_transaction_splits sts
         JOIN ids ON sts.transfer_account_id = ids.id
         UNION ALL
         SELECT st.id, ids.id
         FROM scheduled_transaction_overrides sto
         JOIN scheduled_transactions st
           ON st.id = sto.scheduled_transaction_id
          AND sto.original_date >= st.next_due_date
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(sto.splits) = 'array'
                THEN sto.splits ELSE '[]'::jsonb END) line
         JOIN ids ON lower(line->>'transferAccountId') = ids.id::text
         WHERE sto.is_split IS NOT FALSE
       )
       SELECT refs.account_id AS "accountId",
              COUNT(DISTINCT refs.schedule_id) AS "cnt"
       FROM refs
       JOIN accounts a ON a.id = refs.account_id
       WHERE NOT (a.account_type = ANY($2)
                  AND refs.schedule_id IS NOT DISTINCT FROM a.scheduled_transaction_id)
       GROUP BY refs.account_id`,
      [accountIds, [AccountType.LOAN, AccountType.MORTGAGE]],
    );
  for (const row of rows) counts.set(row.accountId, Number(row.cnt));
  return counts;
}
