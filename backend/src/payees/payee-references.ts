import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { EmailReceiptParser } from "../email-receipts/entities/email-receipt-parser.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Warranty } from "../warranties/entities/warranty.entity";
import { affectedRowCount } from "../common/db/query-result";
import { PayeeAlias } from "./entities/payee-alias.entity";

/** One payee being folded into another, for one user. */
export interface PayeeReassignment {
  userId: string;
  sourcePayeeId: string;
  target: { id: string; name: string };
}

type MoveReference = (
  m: EntityManager,
  reassignment: PayeeReassignment,
) => Promise<number>;

/**
 * Every column with a foreign key to `payees(id)`, each with the statement that
 * points its rows at the surviving payee.
 *
 * A merge deletes the source payee, and every one of these columns but
 * `payee_aliases.payee_id` is `ON DELETE SET NULL`: a column missing here is
 * silently cleared by the delete, which is how a merged payee's warranties,
 * receipt parsers, loan overpayment links and shared-expense people all lost
 * their payee (#2026). `payee-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the schema disagree in either
 * direction, so a migration adding a reference to payees names this map.
 *
 * Keyed `table.column`; every statement is scoped to the merging user.
 */
export const PAYEE_REFERENCE_MOVES = {
  "transactions.payee_id": async (m, { userId, sourcePayeeId, target }) =>
    (
      await m.update(
        Transaction,
        { payeeId: sourcePayeeId, userId },
        { payeeId: target.id, payeeName: target.name },
      )
    ).affected ?? 0,
  "scheduled_transactions.payee_id": async (
    m,
    { userId, sourcePayeeId, target },
  ) =>
    (
      await m.update(
        ScheduledTransaction,
        { payeeId: sourcePayeeId, userId },
        { payeeId: target.id, payeeName: target.name },
      )
    ).affected ?? 0,
  // ON DELETE CASCADE rather than SET NULL: an alias left behind is deleted.
  "payee_aliases.payee_id": async (m, { userId, sourcePayeeId, target }) =>
    (
      await m.update(
        PayeeAlias,
        { payeeId: sourcePayeeId, userId },
        { payeeId: target.id },
      )
    ).affected ?? 0,
  "warranties.payee_id": async (m, { userId, sourcePayeeId, target }) =>
    (
      await m.update(
        Warranty,
        { payeeId: sourcePayeeId, userId },
        { payeeId: target.id },
      )
    ).affected ?? 0,
  // The revision is the parser's compare-and-swap counter: an editor holding
  // the old one must not write the deleted payee back over the move.
  "email_receipt_parsers.payee_id": async (
    m,
    { userId, sourcePayeeId, target },
  ) =>
    (
      await m.update(
        EmailReceiptParser,
        { payeeId: sourcePayeeId, userId },
        { payeeId: target.id, revision: () => "revision + 1" },
      )
    ).affected ?? 0,
  "accounts.overpayment_payee_id": async (
    m,
    { userId, sourcePayeeId, target },
  ) =>
    (
      await m.update(
        Account,
        { overpaymentPayeeId: sourcePayeeId, userId },
        { overpaymentPayeeId: target.id },
      )
    ).affected ?? 0,
  "shared_people.payee_id": async (m, { userId, sourcePayeeId, target }) =>
    affectedRowCount(
      await m.query(
        "UPDATE shared_people SET payee_id = $1 WHERE user_id = $2 AND payee_id = $3",
        [target.id, userId, sourcePayeeId],
      ),
    ),
  // The posting's accepted fingerprint is over the money effect alone, so
  // moving its payee does not flag the entry for review.
  "shared_postings.payee_id": async (m, { userId, sourcePayeeId, target }) =>
    affectedRowCount(
      await m.query(
        "UPDATE shared_postings SET payee_id = $1 WHERE user_id = $2 AND payee_id = $3",
        [target.id, userId, sourcePayeeId],
      ),
    ),
} as const satisfies Record<string, MoveReference>;

export type PayeeReferenceColumn = keyof typeof PAYEE_REFERENCE_MOVES;

/**
 * Point every row that references `sourcePayeeId` at the target, inside the
 * caller's transaction, so the source can then be deleted without its foreign
 * keys clearing anything. Returns the rows moved per column.
 */
export async function reassignPayeeReferences(
  m: EntityManager,
  reassignment: PayeeReassignment,
): Promise<Record<PayeeReferenceColumn, number>> {
  const moved = {} as Record<PayeeReferenceColumn, number>;
  for (const column of Object.keys(
    PAYEE_REFERENCE_MOVES,
  ) as PayeeReferenceColumn[]) {
    moved[column] = await PAYEE_REFERENCE_MOVES[column](m, reassignment);
  }
  return moved;
}
