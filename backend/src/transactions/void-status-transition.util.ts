import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { tr } from "../i18n/translate";
import { lockTransactionRow, LockedTransactionRow } from "../common/db/locks";

/**
 * The two obligations every path that moves a single row across the VOID
 * boundary shares, written once because they were closed on the transfer-edit,
 * bulk and split routes while the dedicated status endpoint
 * (`PATCH /transactions/:id/status`) and the generic row update
 * (`PATCH /transactions/:id`) stayed open -- the least-guarded entry point into
 * exactly the states those routes refuse (recheck of P5-001 scenario B and
 * FR-002).
 *
 * 1. A split-transfer counterpart leg cannot cross the boundary alone: the
 *    parent's split row and total would still record money that left the
 *    source and never arrived. Refuse and point at the parent, which already
 *    has a propagation path.
 * 2. A mirror transfer leg shares the movement of money, so the counterpart
 *    crosses with it and its balance is adjusted by its OWN contribution --
 *    read under the same lock every other balance delta is derived under. A
 *    counterpart that does not lock (a cross-owner leg in another tenant's
 *    scope) is left alone: inclusion is per ledger there, decided per row.
 */

/** The balance-writing surface of AccountsService these helpers need. */
export interface VoidTransitionBalanceWriter {
  updateBalance(accountId: string, amount: number): Promise<unknown>;
  recalculateCurrentBalance(
    userId: string,
    accountId: string,
  ): Promise<unknown>;
}

/**
 * Whether an investment transaction owns this row as its cash leg. Raw EXISTS
 * rather than the InvestmentTransaction repository: this util belongs to the
 * transactions module and only asks whether an owner exists.
 */
export async function isInvestmentCashLeg(
  m: EntityManager,
  transactionId: string,
): Promise<boolean> {
  const rows: { id: string }[] = await m.query(
    // includes VOID rows: records read -- ownership, not effect.
    `SELECT id FROM investment_transactions WHERE transaction_id = $1 LIMIT 1`,
    [transactionId],
  );
  return rows.length > 0;
}

/** Refuse an edit or delete of an investment cash leg; the trade owns it. */
export function investmentCashLegLockedError(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.transactions.investmentCashLegLocked",
      "This transaction is the cash side of an investment transaction. Change or delete the investment transaction instead, so both sides change together.",
    ),
  );
}

/**
 * Refuse a VOID-boundary transition applied to a row that is one half of an
 * event another row owns, on its own. Call inside the write transaction, after
 * establishing the transition actually crosses the boundary. Two cases:
 *
 * - a split-transfer counterpart leg (the parent's split row and total would
 *   still record money that left the source and never arrived);
 * - the linked cash leg of an investment transaction (the trade's shares would
 *   stay counted while its cash claims not to have moved). The investment row
 *   owns the pair's VOID boundary and has its own propagation path
 *   (InvestmentTransactionsService.updateStatus).
 *
 * Reconciliation-state changes never reach this check -- those stay per-ledger.
 */
export async function assertVoidTransitionAllowedOnRow(
  m: EntityManager,
  transactionId: string,
): Promise<void> {
  const owningSplit = await m.getRepository(TransactionSplit).findOne({
    where: { linkedTransactionId: transactionId },
    select: ["id"],
  });
  if (owningSplit) {
    throw new BadRequestException(
      tr(
        "errors.transactions.splitTransferLegStatusLocked",
        "This transfer is part of a split transaction. Void or restore it by editing the split transaction it belongs to, so both sides change together.",
      ),
    );
  }

  if (await isInvestmentCashLeg(m, transactionId)) {
    throw new BadRequestException(
      tr(
        "errors.transactions.investmentCashLegStatusLocked",
        "This transaction is the cash side of an investment transaction. Void or restore it by changing the investment transaction's status, so both sides change together.",
      ),
    );
  }
}

/**
 * Carry a VOID-boundary transition from a locked transfer leg onto its mirror
 * leg, adjusting the mirror's balance by its own amount. Returns the accounts
 * whose balances moved, for the caller's post-commit invalidation.
 *
 * No-op for non-transfer rows, for a counterpart that does not lock under this
 * user (cross-owner: per-ledger inclusion), for a linked row that is a split
 * PARENT (that pairing is governed by the split propagation path), and for a
 * counterpart already on the target side of the boundary.
 */
export async function applyVoidTransitionToMirrorLeg(
  m: EntityManager,
  accounts: VoidTransitionBalanceWriter,
  userId: string,
  row: Pick<LockedTransactionRow, "linkedTransactionId">,
  newStatus: TransactionStatus,
): Promise<string[]> {
  if (!row.linkedTransactionId) return [];

  const counterpart = await lockTransactionRow(
    m,
    row.linkedTransactionId,
    userId,
  );
  if (!counterpart || counterpart.isSplit) return [];

  const isVoid = newStatus === TransactionStatus.VOID;
  const counterpartWasVoid = counterpart.status === TransactionStatus.VOID;
  if (counterpartWasVoid === isVoid) return [];

  await m.update(Transaction, counterpart.id, { status: newStatus });
  if (isTransactionInFuture(counterpart.transactionDate)) {
    await accounts.recalculateCurrentBalance(userId, counterpart.accountId);
  } else {
    await accounts.updateBalance(
      counterpart.accountId,
      isVoid ? -counterpart.amount : counterpart.amount,
    );
  }
  return [counterpart.accountId];
}
