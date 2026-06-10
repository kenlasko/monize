import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { UpdateTransferDto } from "./dto/update-transfer.dto";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";
import { formatCurrency } from "../common/format-currency.util";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}

@Injectable()
export class TransactionTransferService {
  private readonly logger = new Logger(TransactionTransferService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  private triggerNetWorthRecalc(accountId: string, userId: string): void {
    this.netWorthService.triggerDebouncedRecalc(accountId, userId);
  }

  async createTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const {
      fromAccountId,
      toAccountId,
      transactionDate,
      amount,
      fromCurrencyCode,
      toCurrencyCode,
      exchangeRate = 1,
      toAmount: explicitToAmount,
      description,
      payeeId,
      payeeName: customPayeeName,
      referenceNumber,
      status = TransactionStatus.UNRECONCILED,
    } = createTransferDto;

    if (fromAccountId === toAccountId) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferSameAccount",
          "Source and destination accounts must be different",
        ),
      );
    }

    if (amount < 0) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferAmountNegative",
          "Transfer amount must not be negative",
        ),
      );
    }

    const fromAccount = await this.accountsService.findOne(
      userId,
      fromAccountId,
    );
    const toAccount = await this.accountsService.findOne(userId, toAccountId);

    const toAmount =
      explicitToAmount !== undefined
        ? roundMoney(explicitToAmount)
        : roundMoney(amount * exchangeRate);
    const destinationCurrency = toCurrencyCode || fromCurrencyCode;

    const fromPayeeName = customPayeeName || `Transfer to ${toAccount.name}`;
    const toPayeeName = customPayeeName || `Transfer from ${fromAccount.name}`;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedFromId: string;
    let savedToId: string;

    try {
      const fromTransaction = queryRunner.manager.create(Transaction, {
        userId,
        accountId: fromAccountId,
        transactionDate: transactionDate as any,
        amount: -amount,
        currencyCode: fromCurrencyCode,
        exchangeRate: 1,
        description: description || null,
        referenceNumber,
        status,
        isTransfer: true,
        payeeId: payeeId || null,
        payeeName: fromPayeeName,
      });

      const toTransaction = queryRunner.manager.create(Transaction, {
        userId,
        accountId: toAccountId,
        transactionDate: transactionDate as any,
        amount: toAmount,
        currencyCode: destinationCurrency,
        exchangeRate: exchangeRate,
        description: description || null,
        referenceNumber,
        status,
        isTransfer: true,
        payeeId: payeeId || null,
        payeeName: toPayeeName,
      });

      const savedFromTransaction =
        await queryRunner.manager.save(fromTransaction);
      const savedToTransaction = await queryRunner.manager.save(toTransaction);

      savedFromId = savedFromTransaction.id;
      savedToId = savedToTransaction.id;

      await queryRunner.manager.update(Transaction, savedFromId, {
        linkedTransactionId: savedToId,
      });
      await queryRunner.manager.update(Transaction, savedToId, {
        linkedTransactionId: savedFromId,
      });

      if (isTransactionInFuture(transactionDate)) {
        await this.accountsService.recalculateCurrentBalance(
          fromAccountId,
          queryRunner,
        );
        await this.accountsService.recalculateCurrentBalance(
          toAccountId,
          queryRunner,
        );
      } else {
        await this.accountsService.updateBalance(
          fromAccountId,
          -amount,
          queryRunner,
        );
        await this.accountsService.updateBalance(
          toAccountId,
          toAmount,
          queryRunner,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.triggerNetWorthRecalc(fromAccountId, userId);
    this.triggerNetWorthRecalc(toAccountId, userId);

    const result = {
      fromTransaction: await findOne(userId, savedFromId),
      toTransaction: await findOne(userId, savedToId),
    };

    this.actionHistoryService.record(userId, {
      entityType: "transfer",
      entityId: savedFromId,
      action: "create",
      afterData: {
        fromTransactionId: savedFromId,
        toTransactionId: savedToId,
        fromAccountId,
        toAccountId,
      },
      description: `Created transfer ${formatCurrency(amount, fromCurrencyCode)} from ${fromAccount.name} to ${toAccount.name}`,
      descriptionKey: "createdTransfer",
      descriptionParams: {
        amount: formatCurrency(amount, fromCurrencyCode),
        from: fromAccount.name,
        to: toAccount.name,
      },
    });

    return result;
  }

  async getLinkedTransaction(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction | null> {
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      return null;
    }

    try {
      return await findOne(userId, transaction.linkedTransactionId);
    } catch (err) {
      this.logger.warn(
        `Failed to load linked transaction ${transaction.linkedTransactionId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  async removeTransfer(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<void> {
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    const parentSplit = await this.splitsRepository.findOne({
      where: { linkedTransactionId: transactionId },
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const affectedAccountIds = new Set<string>();

    try {
      if (parentSplit) {
        await this.removeTransferFromSplitInTransaction(
          queryRunner,
          parentSplit,
          transaction,
          transactionId,
          affectedAccountIds,
        );
      } else {
        const linkedTransaction = transaction.linkedTransactionId
          ? await queryRunner.manager.findOne(Transaction, {
              where: { id: transaction.linkedTransactionId },
            })
          : null;

        const txIsFuture = isTransactionInFuture(transaction.transactionDate);
        const txAccountId = transaction.accountId;
        affectedAccountIds.add(txAccountId);

        if (!txIsFuture) {
          await this.accountsService.updateBalance(
            txAccountId,
            -Number(transaction.amount),
            queryRunner,
          );
        }

        if (linkedTransaction) {
          const linkedIsFuture = isTransactionInFuture(
            linkedTransaction.transactionDate,
          );
          const linkedAccountId = linkedTransaction.accountId;
          affectedAccountIds.add(linkedAccountId);

          if (!linkedIsFuture) {
            await this.accountsService.updateBalance(
              linkedAccountId,
              -Number(linkedTransaction.amount),
              queryRunner,
            );
          }
          await queryRunner.manager.remove(linkedTransaction);
          if (linkedIsFuture) {
            await this.accountsService.recalculateCurrentBalance(
              linkedAccountId,
              queryRunner,
            );
          }
        }

        await queryRunner.manager.remove(transaction);
        if (txIsFuture) {
          await this.accountsService.recalculateCurrentBalance(
            txAccountId,
            queryRunner,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    for (const accId of affectedAccountIds) {
      this.triggerNetWorthRecalc(accId, userId);
    }
  }

  private async removeTransferFromSplitInTransaction(
    queryRunner: QueryRunner,
    parentSplit: TransactionSplit,
    transaction: Transaction,
    transactionId: string,
    affectedAccountIds: Set<string>,
  ): Promise<void> {
    const parentTransactionId = parentSplit.transactionId;
    const parentTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: parentTransactionId },
    });

    if (parentTransaction) {
      const allSplits = await queryRunner.manager.find(TransactionSplit, {
        where: { transactionId: parentTransactionId },
      });

      for (const split of allSplits) {
        if (
          split.linkedTransactionId &&
          split.linkedTransactionId !== transactionId
        ) {
          const linkedTx = await queryRunner.manager.findOne(Transaction, {
            where: { id: split.linkedTransactionId },
          });

          if (linkedTx) {
            const linkedIsFuture = isTransactionInFuture(
              linkedTx.transactionDate,
            );
            const linkedAccId = linkedTx.accountId;
            affectedAccountIds.add(linkedAccId);
            if (!linkedIsFuture) {
              await this.accountsService.updateBalance(
                linkedAccId,
                -Number(linkedTx.amount),
                queryRunner,
              );
            }
            await queryRunner.manager.remove(linkedTx);
            if (linkedIsFuture) {
              await this.accountsService.recalculateCurrentBalance(
                linkedAccId,
                queryRunner,
              );
            }
          }
        }
      }

      await queryRunner.manager.remove(allSplits);

      const parentIsFuture = isTransactionInFuture(
        parentTransaction.transactionDate,
      );
      affectedAccountIds.add(parentTransaction.accountId);
      if (!parentIsFuture) {
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          -Number(parentTransaction.amount),
          queryRunner,
        );
      }
      await queryRunner.manager.remove(parentTransaction);
      if (parentIsFuture) {
        await this.accountsService.recalculateCurrentBalance(
          parentTransaction.accountId,
          queryRunner,
        );
      }
    }

    const txIsFuture = isTransactionInFuture(transaction.transactionDate);
    affectedAccountIds.add(transaction.accountId);
    if (!txIsFuture) {
      await this.accountsService.updateBalance(
        transaction.accountId,
        -Number(transaction.amount),
        queryRunner,
      );
    }
    await queryRunner.manager.remove(transaction);
    if (txIsFuture) {
      await this.accountsService.recalculateCurrentBalance(
        transaction.accountId,
        queryRunner,
      );
    }
  }

  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    const linkedTransaction = await findOne(
      userId,
      transaction.linkedTransactionId,
    );

    const isFromTransaction = Number(transaction.amount) < 0;
    const fromTransaction = isFromTransaction ? transaction : linkedTransaction;
    const toTransaction = isFromTransaction ? linkedTransaction : transaction;

    const oldFromAccountId = fromTransaction.accountId;
    const oldToAccountId = toTransaction.accountId;
    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);

    const newFromAccountId = updateDto.fromAccountId ?? oldFromAccountId;
    const newToAccountId = updateDto.toAccountId ?? oldToAccountId;

    if (newFromAccountId === newToAccountId) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferSameAccount",
          "Source and destination accounts must be different",
        ),
      );
    }

    let newFromAccount = fromTransaction.account;
    let newToAccount = toTransaction.account;

    if (
      updateDto.fromAccountId &&
      updateDto.fromAccountId !== oldFromAccountId
    ) {
      newFromAccount = await this.accountsService.findOne(
        userId,
        updateDto.fromAccountId,
      );
    }
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      newToAccount = await this.accountsService.findOne(
        userId,
        updateDto.toAccountId,
      );
    }

    const newAmount = updateDto.amount ?? oldFromAmount;
    const newExchangeRate =
      updateDto.exchangeRate ?? toTransaction.exchangeRate;
    const newToAmount =
      updateDto.toAmount !== undefined
        ? roundMoney(updateDto.toAmount)
        : roundMoney(newAmount * newExchangeRate);

    const accountsOrAmountsChanged =
      updateDto.fromAccountId ||
      updateDto.toAccountId ||
      updateDto.amount !== undefined ||
      updateDto.exchangeRate !== undefined ||
      updateDto.toAmount !== undefined;

    const oldDate = fromTransaction.transactionDate;
    const newDate = updateDto.transactionDate ?? oldDate;
    const oldIsFuture = isTransactionInFuture(oldDate);
    const newIsFuture = isTransactionInFuture(newDate);
    const dateChanged = oldDate !== newDate;
    const anyFuture = oldIsFuture || newIsFuture;

    const fromUpdateData = this.buildFromUpdateData(
      updateDto,
      newAmount,
      oldFromAccountId,
      oldToAccountId,
      toTransaction.account?.name ?? "",
      fromTransaction.payeeId,
      fromTransaction.payeeName,
      newToAccount,
    );

    const toUpdateData = this.buildToUpdateData(
      updateDto,
      newToAmount,
      newExchangeRate,
      oldFromAccountId,
      oldToAccountId,
      fromTransaction.account?.name ?? "",
      toTransaction.payeeId,
      toTransaction.payeeName,
      newFromAccount,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if ((accountsOrAmountsChanged || dateChanged) && !anyFuture) {
        await this.accountsService.updateBalance(
          oldFromAccountId,
          oldFromAmount,
          queryRunner,
        );
        await this.accountsService.updateBalance(
          oldToAccountId,
          -oldToAmount,
          queryRunner,
        );
      }

      if (Object.keys(fromUpdateData).length > 0) {
        await queryRunner.manager.update(
          Transaction,
          fromTransaction.id,
          fromUpdateData,
        );
      }

      if (Object.keys(toUpdateData).length > 0) {
        await queryRunner.manager.update(
          Transaction,
          toTransaction.id,
          toUpdateData,
        );
      }

      // Update createdAt via raw query to bypass pg's local-timezone
      // Date serialisation (same approach as transactions.service.ts).
      if ((updateDto as any).createdAt !== undefined) {
        const d = new Date((updateDto as any).createdAt);
        const utc = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
        await queryRunner.query(
          `UPDATE transactions SET created_at = $1 WHERE id = $2`,
          [utc, fromTransaction.id],
        );
        await queryRunner.query(
          `UPDATE transactions SET created_at = $1 WHERE id = $2`,
          [utc, toTransaction.id],
        );
      }

      if (accountsOrAmountsChanged || dateChanged) {
        if (anyFuture) {
          const allAccounts = new Set([
            oldFromAccountId,
            oldToAccountId,
            newFromAccountId,
            newToAccountId,
          ]);
          for (const accId of allAccounts) {
            await this.accountsService.recalculateCurrentBalance(
              accId,
              queryRunner,
            );
          }
        } else {
          await this.accountsService.updateBalance(
            newFromAccountId,
            -newAmount,
            queryRunner,
          );
          await this.accountsService.updateBalance(
            newToAccountId,
            newToAmount,
            queryRunner,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    const affectedAccounts = new Set([
      oldFromAccountId,
      oldToAccountId,
      newFromAccountId,
      newToAccountId,
    ]);
    for (const accId of affectedAccounts) {
      this.triggerNetWorthRecalc(accId, userId);
    }

    return {
      fromTransaction: await findOne(userId, fromTransaction.id),
      toTransaction: await findOne(userId, toTransaction.id),
    };
  }

  private buildFromUpdateData(
    updateDto: Partial<UpdateTransferDto>,
    newAmount: number,
    oldFromAccountId: string,
    oldToAccountId: string,
    oldToAccountName: string,
    existingPayeeId: string | null,
    existingPayeeName: string | null,
    newToAccount: any,
  ): Partial<Transaction> {
    const data: Partial<Transaction> = {};
    if (updateDto.transactionDate)
      data.transactionDate = updateDto.transactionDate as any;
    if (updateDto.amount !== undefined) data.amount = -newAmount;
    if (updateDto.description !== undefined)
      data.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      data.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) data.status = updateDto.status;
    if (updateDto.fromCurrencyCode)
      data.currencyCode = updateDto.fromCurrencyCode;
    if (updateDto.payeeId !== undefined)
      data.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      data.payeeName = updateDto.payeeName || null;
    if (
      updateDto.fromAccountId &&
      updateDto.fromAccountId !== oldFromAccountId
    ) {
      data.accountId = updateDto.fromAccountId;
    }

    const payeeNameCleared =
      updateDto.payeeName !== undefined && !updateDto.payeeName;
    const toAccountChanged =
      !!updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId;
    // Detect auto-generated payee: matches "Transfer to <oldToAccount>" with no
    // linked Payee entity. The frontend re-sends the existing payeeName on edit,
    // so we can't rely on `payeeName === undefined` alone.
    const effectivePayeeName =
      updateDto.payeeName !== undefined
        ? updateDto.payeeName
        : existingPayeeName;
    const effectivePayeeId =
      updateDto.payeeId !== undefined ? updateDto.payeeId : existingPayeeId;
    const payeeWasAutoGenerated =
      !effectivePayeeId &&
      effectivePayeeName === `Transfer to ${oldToAccountName}`;
    const shouldRegenerateDefault =
      payeeNameCleared ||
      (toAccountChanged &&
        (updateDto.payeeName === undefined || payeeWasAutoGenerated));

    if (shouldRegenerateDefault) {
      data.payeeName = `Transfer to ${newToAccount.name}`;
    }

    return data;
  }

  private buildToUpdateData(
    updateDto: Partial<UpdateTransferDto>,
    newToAmount: number,
    newExchangeRate: number,
    oldFromAccountId: string,
    oldToAccountId: string,
    oldFromAccountName: string,
    existingPayeeId: string | null,
    existingPayeeName: string | null,
    newFromAccount: any,
  ): Partial<Transaction> {
    const data: Partial<Transaction> = {};
    if (updateDto.transactionDate)
      data.transactionDate = updateDto.transactionDate as any;
    if (
      updateDto.amount !== undefined ||
      updateDto.exchangeRate !== undefined ||
      updateDto.toAmount !== undefined
    )
      data.amount = newToAmount;
    if (updateDto.description !== undefined)
      data.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      data.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) data.status = updateDto.status;
    if (updateDto.toCurrencyCode) data.currencyCode = updateDto.toCurrencyCode;
    if (updateDto.exchangeRate) data.exchangeRate = updateDto.exchangeRate;
    if (updateDto.payeeId !== undefined)
      data.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      data.payeeName = updateDto.payeeName || null;
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      data.accountId = updateDto.toAccountId;
    }

    const payeeNameCleared =
      updateDto.payeeName !== undefined && !updateDto.payeeName;
    const fromAccountChanged =
      !!updateDto.fromAccountId && updateDto.fromAccountId !== oldFromAccountId;
    const effectivePayeeName =
      updateDto.payeeName !== undefined
        ? updateDto.payeeName
        : existingPayeeName;
    const effectivePayeeId =
      updateDto.payeeId !== undefined ? updateDto.payeeId : existingPayeeId;
    const payeeWasAutoGenerated =
      !effectivePayeeId &&
      effectivePayeeName === `Transfer from ${oldFromAccountName}`;
    const shouldRegenerateDefault =
      payeeNameCleared ||
      (fromAccountChanged &&
        (updateDto.payeeName === undefined || payeeWasAutoGenerated));

    if (shouldRegenerateDefault) {
      data.payeeName = `Transfer from ${newFromAccount.name}`;
    }

    return data;
  }
}
