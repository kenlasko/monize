import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { AccountsService } from "../accounts/accounts.service";
import { categoryFits } from "../categories/category-fit";
import type { CategoryType } from "../categories/category-type.util";
import { ActionHistoryService } from "../action-history/action-history.service";
import { isTransactionInFuture } from "../common/date-utils";
import {
  lockTransactionRow,
  lockTransactionRows,
  LockedTransactionRow,
} from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { formatCurrency } from "../common/format-currency.util";
import { tr } from "../i18n/translate";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { ConvertToTransferDto } from "./dto/convert-to-transfer.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import { removeLockedTransactionLeg } from "./remove-transaction-leg";
import { TransactionSplitService } from "./transaction-split.service";
import {
  fitTransferCategory,
  TransactionTransferService,
  TransferResult,
} from "./transaction-transfer.service";
import { TransactionsService } from "./transactions.service";
import { transferLegColumns } from "./transfer-leg-columns";

/**
 * Converts an existing row between a transaction (plain or split) and one leg
 * of a transfer, in place: the row keeps its id, so its attachments,
 * warranties, tags and history stay with it, and only the counterpart is
 * created or removed. Spec: `docs/specs/transaction-transfer-conversion.md`.
 *
 * Both directions are one `withScopedDb` transaction in which every refusal
 * (ownership, the strict reconciled lock, the row's shape, the counterpart's
 * state) runs under the row locks before the first write. The old shape is
 * reversed exactly as a deletion reverses it and the new one is posted exactly
 * as a create posts it, so the balance arithmetic exists once
 * (INV-BALANCE-001, INV-TRANSFER-001); the net-worth recompute for every
 * account touched is dispatched after the commit (INV-CACHE-001).
 */
@Injectable()
export class TransactionConversionService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private transactionsService: TransactionsService,
    private splitService: TransactionSplitService,
    private transferService: TransactionTransferService,
    private tagsService: TagsService,
    private actionHistoryService: ActionHistoryService,
    private dataSource: DataSource,
  ) {}

  /**
   * Turn an income, expense or split parent into one leg of the transfer `dto`
   * describes. The row stays in its own account when that account is one side
   * of the transfer (it becomes the destination leg when it is the `to`
   * account, the source leg otherwise); a transfer between two other accounts
   * moves it to the source account. Returns both legs, as the create does.
   */
  async convertToTransfer(
    userId: string,
    transactionId: string,
    dto: ConvertToTransferDto,
  ): Promise<TransferResult> {
    const findOne = this.transactionsService.findOne.bind(
      this.transactionsService,
    );
    const transaction = await findOne(userId, transactionId);
    if (transaction.isTransfer || transaction.linkedTransactionId) {
      throw alreadyATransfer();
    }
    const side: "from" | "to" =
      dto.toAccountId === transaction.accountId ? "to" : "from";

    // Everything the create validates and resolves before its write (account
    // access, the FX rate for the date, the payee label) runs here the same
    // way, outside the transaction; a provider lookup must not hold the locks.
    // A foreign leg is refused: the reversal of the row and the legs must
    // commit together, which a cross-owner write cannot (its foreign leg needs
    // the system identity's own transaction).
    const prepared = await this.transferService.prepareTransfer(userId, dto);
    if (prepared.hasForeignLeg) throw crossOwnerConversion();

    const beforeSnapshot =
      this.transactionsService.snapshotTransaction(transaction);
    const affectedAccountIds = new Set<string>();
    const touchedSecurityIds = new Set<string>();
    let counterpartId = "";

    await withScopedDb(this.dataSource, async (m) => {
      // Advisory before row locks, as every split-parent writer does
      // (`common/db/locks.ts`): whether this row holds embedded investment
      // legs is not known until it is locked.
      await this.splitService.lockEmbeddedInvestmentScopes(m, userId, [
        transactionId,
      ]);
      const locked = await lockTransactionRow(m, transactionId, userId);
      if (!locked) throw notFound(transactionId);
      await assertReconciledRowsMutable(m, userId, [locked]);
      // Re-judged on the locked row: a concurrent conversion may have won.
      const row = await m.findOne(Transaction, {
        where: { id: transactionId, userId },
      });
      if (!row) throw notFound(transactionId);
      if (row.isTransfer || row.linkedTransactionId) throw alreadyATransfer();
      // Both legs take the request's category, of any type
      // (INV-CATEGORY-001, INV-CATEGORY-002), checked before the first write.
      await fitTransferCategory(m, userId, dto.categoryId);

      affectedAccountIds.add(locked.accountId);
      affectedAccountIds.add(dto.fromAccountId);
      affectedAccountIds.add(dto.toAccountId);

      // 1. Reverse what the row contributes today, as its deletion would: the
      //    split lines (their counterparts and embedded rows) first, then the
      //    row's own effect. A VOID row contributed nothing.
      if (locked.isSplit) {
        for (const acc of await this.splitService.deleteSplitSideEffects(
          transactionId,
          userId,
          { touchedSecurityIds },
        )) {
          affectedAccountIds.add(acc);
        }
        await m.delete(TransactionSplit, { transactionId });
      }
      const reversal = deletionBalanceEffect(locked);

      // 2. Rewrite the row as its leg and create the other leg, from the
      //    create's own column set. A body that names no status keeps the
      //    row's own (read under the lock), so an API caller converting a
      //    CLEARED row does not silently un-clear it; the create's
      //    UNRECONCILED default is for a row that did not exist yet.
      const legs = transferLegColumns(
        dto.status === undefined
          ? {
              ...prepared,
              dto: {
                ...prepared.dto,
                status: (locked.status ?? undefined) as
                  TransactionStatus | undefined,
              },
            }
          : prepared,
      );
      const own = side === "to" ? legs.to : legs.from;
      const other = side === "to" ? legs.from : legs.to;
      await m.update(
        Transaction,
        { id: transactionId, userId },
        {
          ...own,
          isSplit: false,
          linkedTransactionId: null,
          // A leg is denominated in its account's currency and carries no
          // foreign-currency entry of its own.
          originalAmount: null,
          originalCurrencyCode: null,
          // `externalId` names the row in the account the create wrote it to
          // and is unique there. A row that moves to another account drops
          // it: a retry of that create looks in the old account and would not
          // find the row anyway, and the key could collide with one already
          // held in the new account (the partial unique index would answer
          // with a bare 500 at commit).
          ...(own.accountId !== locked.accountId ? { externalId: null } : {}),
        },
      );
      const counterpart = await m.save(m.create(Transaction, other));
      counterpartId = counterpart.id;
      await m.update(
        Transaction,
        { id: counterpartId, userId },
        { linkedTransactionId: transactionId },
      );
      await m.update(
        Transaction,
        { id: transactionId, userId },
        { linkedTransactionId: counterpartId },
      );

      // 3. Tags: a plain transfer's legs share one set. The body's list
      //    replaces it on both legs (as updateTransfer does); without one the
      //    row's own tags are mirrored onto the new leg.
      if (dto.tagIds !== undefined) {
        await this.tagsService.setTransactionTags(
          transactionId,
          dto.tagIds,
          userId,
        );
        await this.tagsService.setTransactionTags(
          counterpartId,
          dto.tagIds,
          userId,
        );
      } else {
        const tags = await m.find(TransactionTag, {
          where: { transactionId },
        });
        if (tags.length > 0) {
          await this.tagsService.addTransactionTags(
            m,
            userId,
            [counterpartId],
            tags.map((tag) => tag.tagId),
          );
        }
      }

      // 4. Balances. A future date on either shape means a recomputation of
      //    every account touched rather than a delta (the row was, or will
      //    be, outside current_balance); otherwise the reversal and the two
      //    legs are three atomic deltas, each skipped when its row is VOID.
      await this.settleBalances(m, userId, {
        affectedAccountIds,
        anyFuture:
          reversal.needsRecalc || isTransactionInFuture(dto.transactionDate),
        deltas: [
          [locked.accountId, reversal.delta],
          ...(legs.from.status === TransactionStatus.VOID
            ? []
            : ([
                [dto.fromAccountId, -dto.amount],
                [dto.toAccountId, prepared.toAmount],
              ] as [string, number][])),
        ],
      });
    });

    for (const accountId of affectedAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
    await this.splitService.recomputeBondPricesAfterWrite(
      userId,
      touchedSecurityIds,
    );

    const fromId = side === "from" ? transactionId : counterpartId;
    const toId = side === "to" ? transactionId : counterpartId;
    const result: TransferResult = {
      fromTransaction: await findOne(userId, fromId),
      toTransaction: await findOne(userId, toId),
    };
    this.recordConversion(
      userId,
      beforeSnapshot,
      side === "from" ? result.fromTransaction : result.toTransaction,
      "convertedToTransfer",
    );
    return result;
  }

  /**
   * Turn a plain transfer leg back into a transaction: its counterpart is
   * removed and reversed, the leg is detached, and `dto` (the Transaction or
   * Split tab's body) is applied to it by the generic update inside the same
   * transaction. A split-transfer leg is refused (its pairing belongs to the
   * split parent), and so is a leg whose counterpart is another owner's row.
   */
  async convertToTransaction(
    userId: string,
    transactionId: string,
    dto: UpdateTransactionDto,
  ): Promise<Transaction> {
    const transaction = await this.transactionsService.findOne(
      userId,
      transactionId,
    );
    if (!transaction.isTransfer) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }
    const parentSplit = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(TransactionSplit)
        .findOne({ where: { linkedTransactionId: transactionId } }),
    );
    if (parentSplit) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitTransferLegConvertLocked",
          "This transfer is part of a split transaction. Remove it by editing the split on the source transaction instead.",
        ),
      );
    }
    // The owner-scoped read misses a counterpart that is another owner's row.
    if (transaction.linkedTransactionId) {
      try {
        await this.transactionsService.findOne(
          userId,
          transaction.linkedTransactionId,
        );
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
        throw crossOwnerConversion();
      }
    }
    // Provider rate lookups for cross-currency split lines happen out here,
    // before the locks are taken (see prewarmSplitTransferRates).
    if (Array.isArray(dto.splits) && dto.splits.length > 0) {
      await this.splitService.prewarmSplitTransferRates(
        userId,
        dto.splits,
        dto.accountId ?? transaction.accountId,
        dto.transactionDate ?? transaction.transactionDate,
      );
    }

    const beforeSnapshot =
      this.transactionsService.snapshotTransaction(transaction);
    // Every account and security the conversion and the nested update moved,
    // invalidated after the commit.
    const counterpartAccountIds = new Set<string>();
    const touchedSecurityIds = new Set<string>();

    const updated = await withScopedDb(this.dataSource, async (m) => {
      // Both legs, ascending id, the order every transfer writer takes.
      const legIds = [
        transactionId,
        ...(transaction.linkedTransactionId
          ? [transaction.linkedTransactionId]
          : []),
      ];
      const locked = await lockTransactionRows(m, legIds, userId);
      const ownLeg = locked.get(transactionId);
      if (!ownLeg) throw notFound(transactionId);
      const counterpart: LockedTransactionRow | undefined =
        transaction.linkedTransactionId
          ? locked.get(transaction.linkedTransactionId)
          : undefined;
      if (transaction.linkedTransactionId && !counterpart) {
        // Gone or re-owned since the read above: the pair this request
        // described no longer exists, so nothing is written.
        throw new ConflictException(
          tr(
            "errors.transactions.transferCounterpartChanged",
            "The other side of this transfer changed while you were editing. Reload and try again.",
          ),
        );
      }
      // Both legs are one movement of money: a reconciled counterpart refuses
      // the conversion under the strict lock, with nothing written. Without
      // the lock the client has warned and the user has chosen (issue #1937).
      await assertReconciledRowsMutable(
        m,
        userId,
        [ownLeg, counterpart].filter(
          (leg): leg is LockedTransactionRow => leg !== undefined,
        ),
      );

      if (counterpart) {
        counterpartAccountIds.add(counterpart.accountId);
        // Conditional delete, reversing only what the removed row contributed.
        await removeLockedTransactionLeg(
          m,
          counterpart,
          userId,
          this.accountsService,
        );
      }
      // The destination leg stores the pair's rate (source -> destination
      // currency); a plain row's rate belongs to a foreign-currency entry it
      // does not have, so it goes back to 1 with the flag. A provisional
      // amount is a transfer leg's (design P3): the row leaves that state in
      // the write that ends its life as a leg.
      // An ordinary row takes only an Income or Expense category
      // (INV-CATEGORY-001): a Transfer category the leg held is cleared in the
      // same statement that clears `is_transfer`, so the database backstop
      // never sees the row hold one. An Income or Expense category is kept.
      const [heldCategory] = (await m.query(
        `SELECT c.category_type AS "categoryType"
           FROM transactions t JOIN categories c ON c.id = t.category_id
          WHERE t.id = $1`,
        [transactionId],
      )) as { categoryType: CategoryType }[];
      const clearsCategory =
        heldCategory !== undefined && !categoryFits(heldCategory, "category");
      await m.update(
        Transaction,
        { id: transactionId, userId },
        {
          isTransfer: false,
          linkedTransactionId: null,
          exchangeRate: 1,
          amountIsProvisional: false,
          ...(clearsCategory ? { categoryId: null } : {}),
        },
      );

      // The generic update, on the detached row, in this same transaction
      // (its withScopedDb joins the ambient one): category, amount, account,
      // splits, status and tags follow its rules and balance arithmetic. The
      // history entry is this method's, so the update records none, and the
      // accounts and securities it moves are collected here and dispatched
      // after THIS commit (INV-CACHE-001), never inside it.
      return this.transactionsService.update(userId, transactionId, dto, {
        recordHistory: false,
        deferDerivedRecompute: {
          accountIds: counterpartAccountIds,
          securityIds: touchedSecurityIds,
        },
      });
    });

    for (const accountId of counterpartAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
    await this.splitService.recomputeBondPricesAfterWrite(
      userId,
      touchedSecurityIds,
    );
    this.recordConversion(
      userId,
      beforeSnapshot,
      updated,
      "convertedToTransaction",
    );
    return updated;
  }

  /**
   * The balance writes of a conversion to a transfer. `deltas` are applied in
   * order, zeros skipped; with `anyFuture` every affected account is recomputed
   * instead, in a fixed order so two writers of the same accounts cannot take
   * them in opposite orders.
   */
  private async settleBalances(
    m: EntityManager,
    userId: string,
    input: {
      affectedAccountIds: ReadonlySet<string>;
      anyFuture: boolean;
      deltas: readonly [string, number][];
    },
  ): Promise<void> {
    if (input.anyFuture) {
      for (const accountId of [...input.affectedAccountIds].sort()) {
        await this.accountsService.recalculateCurrentBalance(userId, accountId);
      }
      return;
    }
    for (const [accountId, delta] of input.deltas) {
      if (delta === 0) continue;
      await this.accountsService.updateBalance(accountId, delta);
    }
  }

  /**
   * One history entry for the conversion, whose before and after disagree on
   * `isTransfer`; the undo path refuses it, because the counterpart it would
   * need cannot be replayed from the snapshot.
   */
  private recordConversion(
    userId: string,
    beforeData: Record<string, unknown>,
    after: Transaction,
    descriptionKey: "convertedToTransfer" | "convertedToTransaction",
  ): void {
    const amount = formatCurrency(Number(after.amount), after.currencyCode);
    this.actionHistoryService.record(userId, {
      entityType: "transaction",
      entityId: after.id,
      action: "update",
      beforeData,
      afterData: this.transactionsService.snapshotTransaction(after),
      description:
        descriptionKey === "convertedToTransfer"
          ? `Converted transaction ${after.payeeName || ""} ${amount} to a transfer`
          : `Converted transfer ${after.payeeName || ""} ${amount} to a transaction`,
      descriptionKey,
      descriptionParams: {
        payee: after.payeeName || "",
        amount,
        amountValue: Number(after.amount),
        amountCurrency: after.currencyCode,
      },
    });
  }
}

function notFound(id: string): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.transactions.notFoundById",
      `Transaction with ID ${id} not found`,
      {
        id,
      },
    ),
  );
}

function alreadyATransfer(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.transactions.alreadyATransfer",
      "This transaction is already a transfer. Edit the transfer itself instead.",
    ),
  );
}

function crossOwnerConversion(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.transactions.convertTransferCrossOwner",
      "A transfer with another owner's account can't be converted. Delete it and create the entry you want instead.",
    ),
  );
}
