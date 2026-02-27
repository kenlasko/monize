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
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { isTransactionInFuture } from "../common/date-utils";

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
        "Source and destination accounts must be different",
      );
    }

    if (amount <= 0) {
      throw new BadRequestException("Transfer amount must be positive");
    }

    const fromAccount = await this.accountsService.findOne(
      userId,
      fromAccountId,
    );
    const toAccount = await this.accountsService.findOne(userId, toAccountId);

    const toAmount =
      explicitToAmount !== undefined
        ? Math.round(explicitToAmount * 10000) / 10000
        : Math.round(amount * exchangeRate * 10000) / 10000;
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
        description: description || `Transfer to ${toAccount.name}`,
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
        description: description || `Transfer from ${fromAccount.name}`,
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

    return {
      fromTransaction: await findOne(userId, savedFromId),
      toTransaction: await findOne(userId, savedToId),
    };
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
    } catch {
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
      throw new BadRequestException("Transaction is not a transfer");
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
    updateDto: Partial<CreateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      throw new BadRequestException("Transaction is not a transfer");
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
        "Source and destination accounts must be different",
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
        ? Math.round(updateDto.toAmount * 10000) / 10000
        : Math.round(newAmount * newExchangeRate * 10000) / 10000;

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
      newToAccount,
    );

    const toUpdateData = this.buildToUpdateData(
      updateDto,
      newToAmount,
      newExchangeRate,
      oldFromAccountId,
      oldToAccountId,
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
    updateDto: Partial<CreateTransferDto>,
    newAmount: number,
    oldFromAccountId: string,
    oldToAccountId: string,
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

    if (
      updateDto.toAccountId &&
      updateDto.toAccountId !== oldToAccountId &&
      updateDto.payeeName === undefined
    ) {
      data.payeeName = `Transfer to ${newToAccount.name}`;
      if (updateDto.description === undefined) {
        data.description = `Transfer to ${newToAccount.name}`;
      }
    }

    return data;
  }

  private buildToUpdateData(
    updateDto: Partial<CreateTransferDto>,
    newToAmount: number,
    newExchangeRate: number,
    oldFromAccountId: string,
    oldToAccountId: string,
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

    if (
      updateDto.fromAccountId &&
      updateDto.fromAccountId !== oldFromAccountId &&
      updateDto.payeeName === undefined
    ) {
      data.payeeName = `Transfer from ${newFromAccount.name}`;
      if (updateDto.description === undefined) {
        data.description = `Transfer from ${newFromAccount.name}`;
      }
    }

    return data;
  }
}
