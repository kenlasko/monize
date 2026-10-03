import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { investmentLinkedTransactionExclusion } from "../../common/investment-filter.util";
import { tr } from "../../i18n/translate";
import type { ReceiptProposalTransaction } from "../proposal/build-receipt-proposal";

/** The transaction a person names for an email, as the proposal builder reads it. */
export interface LinkableTransaction extends ReceiptProposalTransaction {
  id: string;
}

/**
 * The one predicate for "this transaction may be named by a person for an
 * email": the user's own, not a transfer, not VOID and not an investment row.
 * "Link" (`EmailReceiptPipelineService.process` with `link`) and "Recognize with
 * AI" (`EmailReceiptAiService.askAi` with a transaction) both call it, inside
 * the transaction that stores the choice, so the two refuse the same things in
 * the same words.
 */
export async function loadLinkableTransaction(
  m: EntityManager,
  userId: string,
  transactionId: string,
): Promise<LinkableTransaction> {
  const rows = returnedRows<{
    id: string;
    amount: string | number;
    description: string | null;
    payee_id: string | null;
    is_transfer: boolean;
    status: string | null;
    plain: boolean;
  }>(
    await m.query(
      `SELECT t.id, t.amount, t.description, t.payee_id, t.is_transfer, t.status,
              ${investmentLinkedTransactionExclusion("t")} AS plain
         FROM transactions t
        WHERE t.id = $1
          AND t.user_id = $2`,
      [transactionId, userId],
    ),
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundException(
      tr(
        "errors.emailReceipts.transactionNotFound",
        "That transaction was not found.",
      ),
    );
  }
  if (row.is_transfer) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.linkTransfer",
        "A transfer cannot be linked to an email.",
      ),
    );
  }
  if (row.status === "VOID") {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.linkVoid",
        "A void transaction cannot be linked to an email.",
      ),
    );
  }
  if (!row.plain) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.linkInvestment",
        "An investment transaction cannot be linked to an email.",
      ),
    );
  }
  return {
    id: row.id,
    amount: Number(row.amount),
    description: row.description,
    payeeId: row.payee_id,
  };
}
