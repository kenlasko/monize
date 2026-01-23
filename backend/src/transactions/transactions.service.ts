import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { AccountsService } from '../accounts/accounts.service';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    private accountsService: AccountsService,
  ) {}

  /**
   * Create a new transaction
   */
  async create(
    userId: string,
    createTransactionDto: CreateTransactionDto,
  ): Promise<Transaction> {
    // Verify account belongs to user
    await this.accountsService.findOne(userId, createTransactionDto.accountId);

    const transaction = this.transactionsRepository.create({
      ...createTransactionDto,
      userId,
      exchangeRate: createTransactionDto.exchangeRate || 1,
    });

    const savedTransaction = await this.transactionsRepository.save(transaction);

    // Update account balance
    await this.accountsService.updateBalance(
      createTransactionDto.accountId,
      Number(createTransactionDto.amount),
    );

    return savedTransaction;
  }

  /**
   * Find all transactions for a user with optional filters
   */
  async findAll(
    userId: string,
    accountId?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<Transaction[]> {
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transaction')
      .where('transaction.userId = :userId', { userId })
      .orderBy('transaction.transactionDate', 'DESC')
      .addOrderBy('transaction.createdAt', 'DESC');

    if (accountId) {
      queryBuilder.andWhere('transaction.accountId = :accountId', { accountId });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :endDate', { endDate });
    }

    return queryBuilder.getMany();
  }

  /**
   * Find a single transaction by ID
   */
  async findOne(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.transactionsRepository.findOne({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }

    if (transaction.userId !== userId) {
      throw new ForbiddenException('You do not have access to this transaction');
    }

    return transaction;
  }

  /**
   * Update a transaction
   */
  async update(
    userId: string,
    id: string,
    updateTransactionDto: UpdateTransactionDto,
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    const oldAmount = Number(transaction.amount);
    const oldAccountId = transaction.accountId;

    // If account is being changed, verify new account belongs to user
    if (updateTransactionDto.accountId && updateTransactionDto.accountId !== oldAccountId) {
      await this.accountsService.findOne(userId, updateTransactionDto.accountId);
    }

    Object.assign(transaction, updateTransactionDto);
    const savedTransaction = await this.transactionsRepository.save(transaction);

    // Handle balance updates
    const newAmount = Number(savedTransaction.amount);
    const newAccountId = savedTransaction.accountId;

    if (newAccountId !== oldAccountId) {
      // Transaction moved to different account
      await this.accountsService.updateBalance(oldAccountId, -oldAmount);
      await this.accountsService.updateBalance(newAccountId, newAmount);
    } else if (newAmount !== oldAmount) {
      // Amount changed in same account
      const balanceChange = newAmount - oldAmount;
      await this.accountsService.updateBalance(newAccountId, balanceChange);
    }

    return savedTransaction;
  }

  /**
   * Delete a transaction
   */
  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);

    // Revert the balance change
    await this.accountsService.updateBalance(
      transaction.accountId,
      -Number(transaction.amount),
    );

    await this.transactionsRepository.remove(transaction);
  }

  /**
   * Mark transaction as cleared
   */
  async markCleared(userId: string, id: string, isCleared: boolean): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    transaction.isCleared = isCleared;
    return this.transactionsRepository.save(transaction);
  }

  /**
   * Reconcile a transaction
   */
  async reconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);

    if (transaction.isReconciled) {
      throw new BadRequestException('Transaction is already reconciled');
    }

    transaction.isReconciled = true;
    transaction.reconciledDate = new Date();

    return this.transactionsRepository.save(transaction);
  }

  /**
   * Unreconcile a transaction
   */
  async unreconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);

    if (!transaction.isReconciled) {
      throw new BadRequestException('Transaction is not reconciled');
    }

    transaction.isReconciled = false;
    transaction.reconciledDate = null;

    return this.transactionsRepository.save(transaction);
  }

  /**
   * Get transaction summary statistics
   */
  async getSummary(
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{
    totalIncome: number;
    totalExpenses: number;
    netCashFlow: number;
    transactionCount: number;
  }> {
    const transactions = await this.findAll(userId, undefined, startDate, endDate);

    let totalIncome = 0;
    let totalExpenses = 0;

    transactions.forEach((transaction) => {
      const amount = Number(transaction.amount);
      if (amount > 0) {
        totalIncome += amount;
      } else {
        totalExpenses += Math.abs(amount);
      }
    });

    return {
      totalIncome,
      totalExpenses,
      netCashFlow: totalIncome - totalExpenses,
      transactionCount: transactions.length,
    };
  }
}
