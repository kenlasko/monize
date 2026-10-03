import type { EntityManager } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../../common/db/locks";
import { returnedRows } from "../../common/db/query-result";

/**
 * The two statements every writer of a receipt's request shares, so the
 * pipeline, the receipts service and the AI service close and read a request
 * the same way. Both take the caller's transaction (`withScopedDb` manager).
 *
 * Lock order for a receipt: the receipt row first, then the advisory lock on
 * the transaction its request is about (`lockReceiptTransaction`), then the
 * request rows. No path of this module takes them the other way round.
 */

/** The status of the request a receipt points at, or null when none or gone. */
export async function currentReceiptRequestStatus(
  m: EntityManager,
  userId: string,
  aiReviewRequestId: string | null,
): Promise<string | null> {
  if (!aiReviewRequestId) return null;
  const rows = returnedRows<{ status: string }>(
    await m.query(
      `SELECT status FROM ai_review_requests WHERE id = $1 AND user_id = $2`,
      [aiReviewRequestId, userId],
    ),
  );
  return rows[0]?.status ?? null;
}

/**
 * The advisory lock `enqueueClaimed` and `enqueuePendingForReceipt` take, keyed
 * on the transaction: two writers of rule-less requests for one transaction
 * queue behind one another. Re-entrant within a transaction.
 */
export async function lockReceiptTransaction(
  m: EntityManager,
  transactionId: string,
): Promise<void> {
  await acquireAdvisoryLock(m, LockScope.AiReviewRequests, transactionId);
}

/**
 * Close every open request this receipt raised: `rejected`, the dismissed state.
 * A closed request is never reopened, so a reprocess, an ignore or a delete
 * never leaves a proposal standing behind a receipt that no longer stands
 * behind it.
 */
export async function closeReceiptRequests(
  m: EntityManager,
  userId: string,
  receiptId: string,
): Promise<void> {
  await m.query(
    `UPDATE ai_review_requests
        SET status = 'rejected'
      WHERE user_id = $1
        AND email_receipt_id = $2
        AND status IN ('pending', 'claimed', 'proposed')`,
    [userId, receiptId],
  );
}
