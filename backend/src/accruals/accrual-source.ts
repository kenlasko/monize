import { EntityManager } from "typeorm";
import { lockTransactionRow } from "../common/db/locks";
import { getRequestContext } from "../common/request-context";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import type { AccrualSourceSnapshot } from "./accrual-fingerprint";
import type { AccrualFamily } from "./accrual-balance";
import { accrualErrors } from "./accrual-errors";

export function requireAccrualOwner(userId: string): void {
  const context = getRequestContext();
  if (
    !context ||
    context.system ||
    context.userId !== userId ||
    (context.realUserId ?? userId) !== userId
  )
    throw accrualErrors.owner();
}

export interface AccrualSource {
  readonly snapshot: AccrualSourceSnapshot;
  readonly family: AccrualFamily | null;
  readonly kindEligible: boolean;
}

/**
 * Schedule-only commands never acquire holding/account-balance locks after
 * this source lock. Source writers must retain their advisory-before-row order.
 * Raw decimal/date values deliberately bypass lossy numeric entity transforms.
 */
export async function loadAccrualSource(
  m: EntityManager,
  userId: string,
  transactionId: string,
  splitId: string | null,
  mutable = false,
  eligible = true,
): Promise<AccrualSource> {
  const locked = await lockTransactionRow(m, transactionId, userId);
  if (!locked) throw accrualErrors.missing();
  if (mutable) await assertReconciledRowsMutable(m, userId, [locked]);
  // includes VOID: this is an investment-record identity check, not a sum of financial effects.
  const rows = await m.query(
    `SELECT t.id AS "transactionId", t.user_id AS "userId",
      s.id AS "splitId", t.updated_at::text AS revision,
      CASE WHEN $3::uuid IS NULL THEN t.amount ELSE s.amount END::text AS amount,
      TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS "paymentDate",
      t.account_id AS "accountId", a.currency_code AS "currencyCode",
      cu.decimal_places AS "currencyDecimals",
      CASE WHEN $3::uuid IS NULL THEN t.category_id ELSE s.category_id END AS "categoryId",
      c.user_id AS "categoryOwner", c.is_income AS "isIncome",
      t.payee_id AS "payeeId", COALESCE(t.payee_name, p.name) AS "payeeName",
      COALESCE(s.memo, t.description) AS description,
      COALESCE(t.status, 'UNRECONCILED') AS status,
      t.is_transfer AS "isTransfer", t.is_split AS "isSplit", s.kind AS "splitKind",
      EXISTS (SELECT 1 FROM investment_transactions i WHERE i.transaction_id = t.id) AS "isInvestment",
      CASE WHEN $3::uuid IS NULL THEN t.original_amount::text ELSE NULL END AS "originalAmount",
      t.original_currency_code AS "originalCurrencyCode", t.exchange_rate::text AS "exchangeRate"
     FROM transactions t
     JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
     JOIN currencies cu ON cu.code=a.currency_code
     LEFT JOIN transaction_splits s ON s.id=$3 AND s.transaction_id=t.id
     LEFT JOIN categories c ON c.id=CASE WHEN $3::uuid IS NULL THEN t.category_id ELSE s.category_id END
     LEFT JOIN payees p ON p.id=t.payee_id AND p.user_id=t.user_id
     WHERE t.id=$1 AND t.user_id=$2`,
    [transactionId, userId, splitId],
  );
  const row = rows[0];
  if (!row || (splitId && row.splitId !== splitId))
    throw accrualErrors.missing();
  if (row.categoryId && row.categoryOwner !== userId)
    throw accrualErrors.missing();
  const kindEligible = !(
    row.isTransfer ||
    row.isInvestment ||
    (splitId ? !row.isSplit || row.splitKind !== "category" : row.isSplit)
  );
  if (eligible && (!kindEligible || row.status === "VOID"))
    throw accrualErrors.ineligible();
  const tags: { id: string }[] = await m.query(
    `SELECT tag_id AS id FROM transaction_tags WHERE transaction_id=$1
     UNION SELECT tag_id AS id FROM transaction_split_tags WHERE transaction_split_id=$2`,
    [transactionId, splitId],
  );
  return {
    kindEligible,
    family: row.categoryId ? (row.isIncome ? "income" : "expense") : null,
    snapshot: {
      userId,
      transactionId,
      splitId,
      revision: row.revision,
      amount: row.amount,
      paymentDate: row.paymentDate,
      accountId: row.accountId,
      currencyCode: row.currencyCode,
      currencyDecimals: Number(row.currencyDecimals),
      categoryId: row.categoryId,
      payeeId: row.payeeId,
      payeeName: row.payeeName,
      description: row.description,
      tagIds: tags.map((tag) => tag.id),
      status: row.status,
      originalAmount: row.originalAmount,
      originalCurrencyCode: row.originalCurrencyCode,
      exchangeRate: row.exchangeRate,
    },
  };
}
