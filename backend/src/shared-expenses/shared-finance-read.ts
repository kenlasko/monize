import { EntityManager } from "typeorm";
import {
  SharedIntegration,
  SharedPosting,
  SharedLedgerLink,
  SharedBankRow,
  SHARED_BANK_SELECT,
} from "./shared-finance-types";

export async function sharedIntegration(
  manager: EntityManager,
  userId: string,
  groupId: string,
): Promise<SharedIntegration | null> {
  const rows: SharedIntegration[] = await manager.query(
    `SELECT i.id, i.group_id AS "groupId", i.participant_id AS "participantId", i.account_id AS "accountId", i.is_active AS active,
    a.currency_code AS "currencyCode", a.current_balance AS "currentBalance" FROM shared_integrations i JOIN accounts a ON a.id = i.account_id AND a.user_id = i.user_id
    WHERE i.user_id = $1 AND i.group_id = $2`,
    [userId, groupId],
  );
  return rows[0] ?? null;
}
export async function sharedPostings(
  manager: EntityManager,
  userId: string,
  groupId: string,
): Promise<SharedPosting[]> {
  return manager.query(
    `SELECT id, entry_id AS "entryId", input_fingerprint AS fingerprint, accepted_revision AS "acceptedRevision", accepted_snapshot AS snapshot,
    category_id AS "categoryId", payee_id AS "payeeId",
    COALESCE((SELECT jsonb_agg(l.before_shape ORDER BY l.transaction_id) FROM shared_ledger_links l
      WHERE l.posting_id = shared_postings.id AND l.user_id = shared_postings.user_id
      AND l.kind = 'BANK' AND l.before_shape IS NOT NULL), '[]'::jsonb) AS "originalBanks"
    FROM shared_postings WHERE user_id = $1 AND group_id = $2`,
    [userId, groupId],
  );
}
export async function sharedPostingLinks(
  manager: EntityManager,
  userId: string,
  postingId: string,
): Promise<SharedLedgerLink[]> {
  return manager.query(
    `SELECT transaction_id AS "transactionId", kind, created_by_bridge AS created, before_shape AS before
    FROM shared_ledger_links WHERE user_id = $1 AND posting_id = $2 ORDER BY transaction_id`,
    [userId, postingId],
  );
}
export async function sharedBankRows(
  manager: EntityManager,
  userId: string,
  ids: string[],
): Promise<SharedBankRow[]> {
  if (!ids.length) return [];
  // Structural eligibility includes VOID: a trade-linked bank row or split
  // cannot be repurposed even while that trade contributes no balance effect.
  return manager.query(
    `SELECT ${SHARED_BANK_SELECT},
    EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = transactions.id) AS "investmentLinked",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'kind', s.kind, 'amount', s.amount::text, 'categoryId', s.category_id,
      'memo', s.memo, 'createdAt', s.created_at, 'transferAccountId', s.transfer_account_id,
      'linkedTransactionId', s.linked_transaction_id,
      'investmentLinked', EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_split_id = s.id),
      'tagIds', COALESCE((SELECT jsonb_agg(st.tag_id ORDER BY st.tag_id) FROM transaction_split_tags st WHERE st.transaction_split_id = s.id), '[]'::jsonb)
    ) ORDER BY s.id) FROM transaction_splits s WHERE s.transaction_id = transactions.id), '[]'::jsonb) AS splits
    FROM transactions WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [userId, ids],
  );
}
