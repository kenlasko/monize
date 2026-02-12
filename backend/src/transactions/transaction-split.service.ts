import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { AccountsService } from "../accounts/accounts.service";

@Injectable()
export class TransactionSplitService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
  ) {}

  validateSplits(
    splits: CreateTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    const isTransfer = splits.length === 1 && splits[0].transferAccountId;

    if (splits.length < 2 && !isTransfer) {
      throw new BadRequestException(
        "Split transactions must have at least 2 splits",
      );
    }

    const splitsSum = splits.reduce(
      (sum, split) => sum + Number(split.amount),
      0,
    );
    const roundedSum = Math.round(splitsSum * 10000) / 10000;
    const roundedAmount = Math.round(Number(transactionAmount) * 10000) / 10000;

    if (roundedSum !== roundedAmount) {
      throw new BadRequestException(
        `Split amounts (${roundedSum}) must equal transaction amount (${roundedAmount})`,
      );
    }

    for (const split of splits) {
      if (split.amount === 0) {
        throw new BadRequestException("Split amounts cannot be zero");
      }
    }
  }

  async createSplits(
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
  ): Promise<TransactionSplit[]> {
    const savedSplits: TransactionSplit[] = [];

    for (const split of splits) {
      const splitEntity = this.splitsRepository.create({
        transactionId,
        categoryId: split.categoryId || null,
        transferAccountId: split.transferAccountId || null,
        amount: split.amount,
        memo: split.memo || null,
      });

      const savedSplit = await this.splitsRepository.save(splitEntity);

      if (split.transferAccountId && userId && sourceAccountId) {
        const targetAccount = await this.accountsService.findOne(
          userId,
          split.transferAccountId,
        );
        const sourceAccount = await this.accountsService.findOne(
          userId,
          sourceAccountId,
        );

        const linkedTransaction = this.transactionsRepository.create({
          userId,
          accountId: split.transferAccountId,
          transactionDate: transactionDate as any,
          amount: -split.amount,
          currencyCode: targetAccount.currencyCode,
          exchangeRate: 1,
          description: split.memo || null,
          isTransfer: true,
          payeeName: parentPayeeName || `Transfer from ${sourceAccount.name}`,
        });

        const savedLinkedTransaction =
          await this.transactionsRepository.save(linkedTransaction);

        await this.splitsRepository.update(savedSplit.id, {
          linkedTransactionId: savedLinkedTransaction.id,
        });

        await this.transactionsRepository.update(savedLinkedTransaction.id, {
          linkedTransactionId: transactionId,
        });

        await this.accountsService.updateBalance(
          split.transferAccountId,
          -split.amount,
        );

        savedSplit.linkedTransactionId = savedLinkedTransaction.id;
      }

      savedSplits.push(savedSplit);
    }

    return savedSplits;
  }

  async deleteTransferSplitLinkedTransactions(
    transactionId: string,
  ): Promise<void> {
    const transferSplits = await this.splitsRepository.find({
      where: { transactionId },
      relations: ["linkedTransaction"],
    });

    for (const split of transferSplits) {
      if (split.linkedTransactionId && split.transferAccountId) {
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
  }

  async getSplits(
    transactionId: string,
  ): Promise<TransactionSplit[]> {
    return this.splitsRepository.find({
      where: { transactionId },
      relations: ["category", "transferAccount"],
      order: { createdAt: "ASC" },
    });
  }

  async updateSplits(
    transaction: Transaction,
    splits: CreateTransactionSplitDto[],
    userId: string,
  ): Promise<TransactionSplit[]> {
    this.validateSplits(splits, transaction.amount);

    await this.deleteTransferSplitLinkedTransactions(transaction.id);

    await this.splitsRepository.delete({ transactionId: transaction.id });

    const newSplits = await this.createSplits(
      transaction.id,
      splits,
      userId,
      transaction.accountId,
      new Date(transaction.transactionDate),
      transaction.payeeName,
    );

    await this.transactionsRepository.update(transaction.id, {
      isSplit: true,
      categoryId: null,
    });

    return newSplits;
  }

  async addSplit(
    transaction: Transaction,
    splitDto: CreateTransactionSplitDto,
    userId: string,
  ): Promise<TransactionSplit> {
    const existingSplits = await this.getSplits(transaction.id);
    const existingTotal = existingSplits.reduce(
      (sum, s) => sum + Number(s.amount),
      0,
    );
    const newTotal = existingTotal + Number(splitDto.amount);

    const roundedNewTotal = Math.round(newTotal * 10000) / 10000;
    const roundedTransactionAmount =
      Math.round(Number(transaction.amount) * 10000) / 10000;

    if (Math.abs(roundedNewTotal) > Math.abs(roundedTransactionAmount)) {
      throw new BadRequestException(
        `Adding this split would exceed the transaction amount. ` +
          `Current total: ${existingTotal}, New split: ${splitDto.amount}, ` +
          `Transaction amount: ${transaction.amount}`,
      );
    }

    const split = this.splitsRepository.create({
      transactionId: transaction.id,
      categoryId: splitDto.categoryId || null,
      transferAccountId: splitDto.transferAccountId || null,
      amount: splitDto.amount,
      memo: splitDto.memo || null,
    });

    const savedSplit = await this.splitsRepository.save(split);

    if (splitDto.transferAccountId) {
      const targetAccount = await this.accountsService.findOne(
        userId,
        splitDto.transferAccountId,
      );
      const sourceAccount = await this.accountsService.findOne(
        userId,
        transaction.accountId,
      );

      const linkedTransaction = this.transactionsRepository.create({
        userId,
        accountId: splitDto.transferAccountId,
        transactionDate: transaction.transactionDate,
        amount: -splitDto.amount,
        currencyCode: targetAccount.currencyCode,
        exchangeRate: 1,
        description: splitDto.memo || null,
        isTransfer: true,
        payeeName:
          transaction.payeeName || `Transfer from ${sourceAccount.name}`,
      });

      const savedLinkedTransaction =
        await this.transactionsRepository.save(linkedTransaction);

      await this.splitsRepository.update(savedSplit.id, {
        linkedTransactionId: savedLinkedTransaction.id,
      });

      await this.accountsService.updateBalance(
        splitDto.transferAccountId,
        -splitDto.amount,
      );

      savedSplit.linkedTransactionId = savedLinkedTransaction.id;
    }

    const totalSplits = existingSplits.length + 1;
    if (totalSplits >= 2 && !transaction.isSplit) {
      await this.transactionsRepository.update(transaction.id, {
        isSplit: true,
        categoryId: null,
      });
    }

    const splitWithRelations = await this.splitsRepository.findOne({
      where: { id: savedSplit.id },
      relations: ["category", "transferAccount"],
    });

    if (!splitWithRelations) {
      throw new NotFoundException(`Split with ID ${savedSplit.id} not found`);
    }

    return splitWithRelations;
  }

  async removeSplit(
    transaction: Transaction,
    splitId: string,
    userId: string,
  ): Promise<void> {
    const split = await this.splitsRepository.findOne({
      where: { id: splitId, transactionId: transaction.id },
    });

    if (!split) {
      throw new NotFoundException(`Split with ID ${splitId} not found`);
    }

    if (split.linkedTransactionId && split.transferAccountId) {
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

    await this.splitsRepository.remove(split);

    const remainingSplits = await this.getSplits(transaction.id);
    if (remainingSplits.length < 2) {
      if (remainingSplits.length === 1) {
        const lastSplit = remainingSplits[0];

        if (lastSplit.linkedTransactionId && lastSplit.transferAccountId) {
          const linkedTx = await this.transactionsRepository.findOne({
            where: { id: lastSplit.linkedTransactionId },
          });

          if (linkedTx) {
            await this.accountsService.updateBalance(
              linkedTx.accountId,
              -Number(linkedTx.amount),
            );
            await this.transactionsRepository.remove(linkedTx);
          }
        }

        await this.transactionsRepository.update(transaction.id, {
          isSplit: false,
          categoryId: lastSplit.categoryId,
        });
        await this.splitsRepository.remove(lastSplit);
      } else {
        await this.transactionsRepository.update(transaction.id, {
          isSplit: false,
        });
      }
    }
  }
}
