import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}

@Injectable()
export class TransactionTransferService {
  private readonly logger = new Logger(TransactionTransferService.name);
  private readonly recalcTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private static readonly RECALC_DEBOUNCE_MS = 2000;

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
  ) {}

  private triggerNetWorthRecalc(accountId: string, userId: string): void {
    const key = `${userId}:${accountId}`;
    const existing = this.recalcTimers.get(key);
    if (existing) clearTimeout(existing);

    this.recalcTimers.set(
      key,
      setTimeout(() => {
        this.recalcTimers.delete(key);
        this.netWorthService
          .recalculateAccount(userId, accountId)
          .catch((err) =>
            this.logger.warn(
              `Net worth recalc failed for account ${accountId}: ${err.message}`,
            ),
          );
      }, TransactionTransferService.RECALC_DEBOUNCE_MS),
    );
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

    const fromTransaction = this.transactionsRepository.create({
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

    const toTransaction = this.transactionsRepository.create({
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
      await this.transactionsRepository.save(fromTransaction);
    const savedToTransaction =
      await this.transactionsRepository.save(toTransaction);

    await this.transactionsRepository.update(savedFromTransaction.id, {
      linkedTransactionId: savedToTransaction.id,
    });
    await this.transactionsRepository.update(savedToTransaction.id, {
      linkedTransactionId: savedFromTransaction.id,
    });

    await this.accountsService.updateBalance(fromAccountId, -amount);
    await this.accountsService.updateBalance(toAccountId, toAmount);

    this.triggerNetWorthRecalc(fromAccountId, userId);
    this.triggerNetWorthRecalc(toAccountId, userId);

    return {
      fromTransaction: await findOne(userId, savedFromTransaction.id),
      toTransaction: await findOne(userId, savedToTransaction.id),
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

    if (parentSplit) {
      await this.removeTransferFromSplit(
        parentSplit,
        transaction,
        transactionId,
        userId,
      );
      return;
    }

    const linkedTransaction = transaction.linkedTransactionId
      ? await this.transactionsRepository.findOne({
          where: { id: transaction.linkedTransactionId },
        })
      : null;

    await this.accountsService.updateBalance(
      transaction.accountId,
      -Number(transaction.amount),
    );

    if (linkedTransaction) {
      await this.accountsService.updateBalance(
        linkedTransaction.accountId,
        -Number(linkedTransaction.amount),
      );
      this.triggerNetWorthRecalc(linkedTransaction.accountId, userId);
      await this.transactionsRepository.remove(linkedTransaction);
    }

    this.triggerNetWorthRecalc(transaction.accountId, userId);

    await this.transactionsRepository.remove(transaction);
  }

  private async removeTransferFromSplit(
    parentSplit: TransactionSplit,
    transaction: Transaction,
    transactionId: string,
    userId: string,
  ): Promise<void> {
    const parentTransactionId = parentSplit.transactionId;
    const parentTransaction = await this.transactionsRepository.findOne({
      where: { id: parentTransactionId },
    });

    if (parentTransaction) {
      const allSplits = await this.splitsRepository.find({
        where: { transactionId: parentTransactionId },
      });

      for (const split of allSplits) {
        if (
          split.linkedTransactionId &&
          split.linkedTransactionId !== transactionId
        ) {
          const linkedTx = await this.transactionsRepository.findOne({
            where: { id: split.linkedTransactionId },
          });

          if (linkedTx) {
            await this.accountsService.updateBalance(
              linkedTx.accountId,
              -Number(linkedTx.amount),
            );
            await this.transactionsRepository.remove(linkedTx);
          }
        }
      }

      await this.splitsRepository.remove(allSplits);

      await this.accountsService.updateBalance(
        parentTransaction.accountId,
        -Number(parentTransaction.amount),
      );
      await this.transactionsRepository.remove(parentTransaction);
    }

    await this.accountsService.updateBalance(
      transaction.accountId,
      -Number(transaction.amount),
    );
    this.triggerNetWorthRecalc(transaction.accountId, userId);
    await this.transactionsRepository.remove(transaction);
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

    if (accountsOrAmountsChanged) {
      await this.accountsService.updateBalance(oldFromAccountId, oldFromAmount);
      await this.accountsService.updateBalance(oldToAccountId, -oldToAmount);
    }

    const fromUpdateData = this.buildFromUpdateData(
      updateDto,
      newAmount,
      oldFromAccountId,
      oldToAccountId,
      newToAccount,
    );

    if (Object.keys(fromUpdateData).length > 0) {
      await this.transactionsRepository.update(
        fromTransaction.id,
        fromUpdateData,
      );
    }

    const toUpdateData = this.buildToUpdateData(
      updateDto,
      newToAmount,
      newExchangeRate,
      oldFromAccountId,
      oldToAccountId,
      newFromAccount,
    );

    if (Object.keys(toUpdateData).length > 0) {
      await this.transactionsRepository.update(toTransaction.id, toUpdateData);
    }

    if (accountsOrAmountsChanged) {
      await this.accountsService.updateBalance(newFromAccountId, -newAmount);
      await this.accountsService.updateBalance(newToAccountId, newToAmount);
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
