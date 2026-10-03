import type { EntityManager } from "typeorm";
import { investmentExclusionSql } from "../../common/investment-filter.util";
import {
  receiptCandidateWindow,
  type ReceiptMatchCandidate,
} from "../matching/match-receipt";

/** Spec section 3: at most this many candidates, newest first. */
export const RECEIPT_CANDIDATE_LIMIT = 200;

/** Never a cash leg a trade generated, nor an embedded investment line (INV-REPORT-001). */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

interface CandidateRow {
  id: string;
  transaction_date: string;
  amount: string | number;
  payee_id: string | null;
  payee_name: string | null;
  description: string | null;
  reference_number: string | null;
}

/**
 * The transactions an email received on `receivedDate` (`YYYY-MM-DD`, UTC) can
 * have paid for, in ONE query (spec section 3): the user's own, not a transfer,
 * not VOID, not investment-linked, dated inside `receiptCandidateWindow`, at
 * most 200, newest first.
 *
 * Left out: a transaction that already has an applied email-receipt request (it
 * was enriched), and one with an open request no rule made (`rule_id IS NULL`:
 * the queue's partial unique index does not cover those, so the exclusion is
 * this predicate plus the advisory lock `enqueueClaimed` takes). The receipt's
 * own open request (`ownReceiptId`) does not count: the caller is about to
 * replace it.
 *
 * A DATE is read with `TO_CHAR` and a numeric with `Number`, never through the
 * entity transformer (backend/CLAUDE.md). Read-only, so it is safe inside a
 * preview as well as inside the write that follows a match.
 */
export async function loadReceiptCandidates(
  m: EntityManager,
  userId: string,
  receivedDate: string,
  ownReceiptId: string | null,
): Promise<ReceiptMatchCandidate[]> {
  const window = receiptCandidateWindow(receivedDate);
  const rows: CandidateRow[] = await m.query(
    `SELECT t.id,
            TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
            t.amount,
            t.payee_id,
            t.payee_name,
            t.description,
            t.reference_number
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND t.transaction_date >= $2::date
        AND t.transaction_date <= $3::date
        AND ${INVESTMENT_EXCLUSION}
        AND NOT EXISTS (
              SELECT 1
                FROM ai_review_requests applied
               WHERE applied.transaction_id = t.id
                 AND applied.user_id = $1
                 AND applied.kind = 'email_receipt'
                 AND applied.status = 'applied')
        AND NOT EXISTS (
              SELECT 1
                FROM ai_review_requests open_request
               WHERE open_request.transaction_id = t.id
                 AND open_request.user_id = $1
                 AND open_request.rule_id IS NULL
                 AND open_request.status IN ('pending', 'claimed', 'proposed')
                 AND open_request.expires_at > CURRENT_TIMESTAMP
                 AND open_request.email_receipt_id IS DISTINCT FROM $4::uuid)
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT $5`,
    [userId, window.from, window.to, ownReceiptId, RECEIPT_CANDIDATE_LIMIT],
  );
  return rows.map((row) => ({
    id: row.id,
    transactionDate: row.transaction_date,
    amount: Number(row.amount),
    payeeId: row.payee_id,
    payeeName: row.payee_name,
    description: row.description,
    referenceNumber: row.reference_number,
  }));
}
