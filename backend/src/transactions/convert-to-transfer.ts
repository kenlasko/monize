import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { AccountsService } from "../accounts/accounts.service";
import { Account } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { lockTransactionRow } from "../common/db/locks";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";

/** The two balance operations the conversion needs from the accounts service. */
export type ConvertBalanceWriter = Pick<
  AccountsService,
  "updateBalance" | "recalculateCurrentBalance"
>;

export interface ConvertToTransferOptions {
  /** Clear the row's category: a transfer leg carries none of its own. */
  readonly clearCategory: boolean;
  /**
   * The counterpart amount the rule planned. The write refuses when the row,
   * read under its lock, would now produce a different one: the plan (and a
   * run's fingerprint) described another sum.
   */
  readonly expectedCounterpartAmount?: number;
}

export interface ConvertToTransferResult {
  /** The leg created in the target account. */
  readonly counterpartId: string;
  /** The accounts whose balance moved (the target only). */
  readonly affectedAccountIds: readonly string[];
}

/**
 * A defensive refusal. The rule planner refuses every one of these before
 * anything is written (spec section 4), so reaching one means the row changed
 * between the plan and the write; the throw rolls the caller's transaction
 * back instead of writing a transfer nobody planned.
 */
function refuse(reason: string): ConflictException {
  return new ConflictException({
    message: tr(
      "errors.transactions.convertToTransferRefused",
      "This transaction can no longer be converted to a transfer. Review it and run the rule again",
    ),
    errorCode: "CONVERT_TO_TRANSFER_REFUSED",
    reason,
  });
}

/**
 * Turn an existing income or expense into one leg of a transfer, for a
 * transaction rule's `convert_to_transfer` action (spec
 * `docs/specs/transaction-rules-structural-actions.md` section 5).
 *
 * Runs on the caller's `EntityManager`, in the transaction that wrote the row
 * or locked it. It creates the counterpart leg in `targetAccountId` exactly the
 * way `writeTransferLegs` creates the receiving leg (amount `-row.amount`,
 * same date, description, reference, status and payee, no category), links the
 * two legs, marks the row a transfer leg, mirrors its tags onto the
 * counterpart, and moves the TARGET account's balance by the counterpart's
 * amount. The row's own account never moves: its amount did not change
 * (INV-RULE-001). A VOID row is refused (INV-TRANSFER-001: it would move no
 * balance and the planner never plans it); a future-dated one is folded in by
 * a recomputation, not a delta.
 *
 * The caller dispatches the net-worth recompute for `affectedAccountIds`
 * after its commit (INV-CACHE-001); nothing is triggered in here.
 */
export async function convertRowToTransfer(
  m: EntityManager,
  accountsService: ConvertBalanceWriter,
  userId: string,
  rowId: string,
  targetAccountId: string,
  options: ConvertToTransferOptions,
): Promise<ConvertToTransferResult> {
  // The row was written or locked by this transaction already; the lock makes
  // the read below the version the conversion replaces.
  const locked = await lockTransactionRow(m, rowId, userId);
  if (!locked) throw refuse("the transaction no longer exists");
  const row = await m.findOne(Transaction, { where: { id: rowId, userId } });
  if (!row) throw refuse("the transaction no longer exists");
  if (row.isTransfer || row.linkedTransactionId) {
    throw refuse("it is already a transfer leg");
  }
  if (row.isSplit) throw refuse("it is a split");
  if (row.status === TransactionStatus.VOID) throw refuse("it is void");
  if (row.accountId === targetAccountId) {
    throw refuse("the target is its own account");
  }
  const target = await m.findOne(Account, {
    where: { id: targetAccountId, userId },
  });
  if (!target) throw refuse("the target account was not found");
  if (target.currencyCode.toUpperCase() !== row.currencyCode.toUpperCase()) {
    throw refuse("the accounts hold different currencies");
  }

  const counterpartAmount = roundMoney(-Number(row.amount));
  if (
    options.expectedCounterpartAmount !== undefined &&
    roundMoney(options.expectedCounterpartAmount) !== counterpartAmount
  ) {
    throw refuse("its amount changed since the rule was planned");
  }
  const counterpart = await m.save(
    m.create(Transaction, {
      userId,
      accountId: targetAccountId,
      transactionDate: row.transactionDate,
      amount: counterpartAmount,
      currencyCode: target.currencyCode,
      exchangeRate: 1,
      description: row.description,
      referenceNumber: row.referenceNumber,
      status: row.status,
      isTransfer: true,
      // The payee is stored as the row has it, a blank one blank: the display
      // label is resolved at read time (transfer-payee-label.util.ts, #1214).
      payeeId: row.payeeId,
      payeeName: row.payeeName,
      categoryId: null,
    }),
  );

  await m.update(
    Transaction,
    { id: counterpart.id, userId },
    { linkedTransactionId: row.id },
  );
  await m.update(
    Transaction,
    { id: row.id, userId },
    {
      linkedTransactionId: counterpart.id,
      isTransfer: true,
      ...(options.clearCategory ? { categoryId: null } : {}),
    },
  );

  // Plain transfer legs share one tag set with their mirror leg.
  const tags = await m.find(TransactionTag, {
    where: { transactionId: row.id },
  });
  if (tags.length > 0) {
    await m
      .createQueryBuilder()
      .insert()
      .into(TransactionTag)
      .values(
        tags.map((link) => ({
          transactionId: counterpart.id,
          tagId: link.tagId,
        })),
      )
      .orIgnore()
      .execute();
  }

  // The target's balance moves by the counterpart's amount alone. The row's
  // account is untouched: the row's amount did not change.
  if (isTransactionInFuture(row.transactionDate)) {
    await accountsService.recalculateCurrentBalance(userId, targetAccountId);
  } else {
    await accountsService.updateBalance(targetAccountId, counterpartAmount);
  }

  return {
    counterpartId: counterpart.id,
    affectedAccountIds: [targetAccountId],
  };
}
