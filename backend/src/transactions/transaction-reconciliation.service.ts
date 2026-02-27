import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { AccountsService } from "../accounts/accounts.service";
import { isTransactionInFuture } from "../common/date-utils";

@Injectable()
export class TransactionReconciliationService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
  ) {}

  async updateStatus(
    transaction: Transaction,
    status: TransactionStatus,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;
    const isVoid = status === TransactionStatus.VOID;

    if (isTransactionInFuture(transaction.transactionDate)) {
      if (wasVoid !== isVoid) {
        await this.transactionsRepository.update(transaction.id, { status });
        await this.accountsService.recalculateCurrentBalance(
          transaction.accountId,
        );
      } else {
        await this.transactionsRepository.update(transaction.id, { status });
      }
    } else {
      if (wasVoid && !isVoid) {
        await this.accountsService.updateBalance(
          transaction.accountId,
          Number(transaction.amount),
        );
      } else if (!wasVoid && isVoid) {
        await this.accountsService.updateBalance(
          transaction.accountId,
          -Number(transaction.amount),
        );
      }
      await this.transactionsRepository.update(transaction.id, { status });
    }

    if (wasVoid !== isVoid) {
      triggerNetWorthRecalc(transaction.accountId, userId);
    }

    if (
      status === TransactionStatus.RECONCILED &&
      oldStatus !== TransactionStatus.RECONCILED
    ) {
      const now = new Date();
      const reconciledDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      await this.transactionsRepository.update(transaction.id, {
        reconciledDate,
      });
    }

    return findOne(userId, transaction.id);
  }

  async markCleared(
    transaction: Transaction,
    isCleared: boolean,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (
      transaction.status === TransactionStatus.RECONCILED ||
      transaction.status === TransactionStatus.VOID
    ) {
      throw new BadRequestException(
        "Cannot change cleared status of reconciled or void transactions",
      );
    }

    const newStatus = isCleared
      ? TransactionStatus.CLEARED
      : TransactionStatus.UNRECONCILED;
    return this.updateStatus(
      transaction,
      newStatus,
      userId,
      triggerNetWorthRecalc,
      findOne,
    );
  }

  async reconcile(
    transaction: Transaction,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (transaction.status === TransactionStatus.RECONCILED) {
      throw new BadRequestException("Transaction is already reconciled");
    }

    if (transaction.status === TransactionStatus.VOID) {
      throw new BadRequestException("Cannot reconcile a void transaction");
    }

    return this.updateStatus(
      transaction,
      TransactionStatus.RECONCILED,
      userId,
      triggerNetWorthRecalc,
      findOne,
    );
  }

  async unreconcile(
    transaction: Transaction,
    userId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (transaction.status !== TransactionStatus.RECONCILED) {
      throw new BadRequestException("Transaction is not reconciled");
    }

    await this.transactionsRepository.update(transaction.id, {
      status: TransactionStatus.CLEARED,
      reconciledDate: null,
    });

    return findOne(userId, transaction.id);
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ): Promise<{
    transactions: Transaction[];
    reconciledBalance: number;
    clearedBalance: number;
    difference: number;
  }> {
    const [account, transactions, reconciledResult, clearedResult] =
      await Promise.all([
        this.accountsService.findOne(userId, accountId),
        this.transactionsRepository
          .createQueryBuilder("transaction")
          .leftJoinAndSelect("transaction.payee", "payee")
          .leftJoinAndSelect("transaction.category", "category")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status IN (:...statuses)", {
            statuses: [
              TransactionStatus.UNRECONCILED,
              TransactionStatus.CLEARED,
            ],
          })
          .andWhere("transaction.transactionDate <= :statementDate", {
            statementDate,
          })
          .orderBy("transaction.transactionDate", "ASC")
          .addOrderBy("transaction.createdAt", "ASC")
          .getMany(),
        this.transactionsRepository
          .createQueryBuilder("transaction")
          .select("SUM(transaction.amount)", "sum")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status = :status", {
            status: TransactionStatus.RECONCILED,
          })
          .getRawOne(),
        this.transactionsRepository
          .createQueryBuilder("transaction")
          .select("SUM(transaction.amount)", "sum")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status = :status", {
            status: TransactionStatus.CLEARED,
          })
          .andWhere("transaction.transactionDate <= :statementDate", {
            statementDate,
          })
          .getRawOne(),
      ]);

    const reconciledSum = Number(reconciledResult?.sum) || 0;
    const reconciledBalance = Number(account.openingBalance) + reconciledSum;

    const clearedSum = Number(clearedResult?.sum) || 0;
    const clearedBalance = reconciledBalance + clearedSum;

    const difference = statementBalance - clearedBalance;

    return {
      transactions,
      reconciledBalance,
      clearedBalance,
      difference,
    };
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<{ reconciled: number }> {
    await this.accountsService.findOne(userId, accountId);

    if (transactionIds.length === 0) {
      return { reconciled: 0 };
    }

    const transactions = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .where("transaction.id IN (:...ids)", { ids: transactionIds })
      .andWhere("transaction.userId = :userId", { userId })
      .andWhere("transaction.accountId = :accountId", { accountId })
      .getMany();

    if (transactions.length !== transactionIds.length) {
      throw new BadRequestException(
        "Some transactions were not found or do not belong to the specified account",
      );
    }

    const voidTransactions = transactions.filter(
      (t) => t.status === TransactionStatus.VOID,
    );
    if (voidTransactions.length > 0) {
      throw new BadRequestException("Cannot reconcile void transactions");
    }

    await this.transactionsRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        status: TransactionStatus.RECONCILED,
        reconciledDate: reconciledDate,
      })
      .where("id IN (:...ids)", { ids: transactionIds })
      .andWhere("userId = :userId", { userId })
      .execute();

    return { reconciled: transactions.length };
  }
}
