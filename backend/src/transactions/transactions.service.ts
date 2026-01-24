import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import { TransactionSplit } from './entities/transaction-split.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { CreateTransactionSplitDto } from './dto/create-transaction-split.dto';
import { AccountsService } from '../accounts/accounts.service';
import { PayeesService } from '../payees/payees.service';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    private accountsService: AccountsService,
    private payeesService: PayeesService,
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

    const { splits, ...transactionData } = createTransactionDto;
    const hasSplits = splits && splits.length > 0;

    // Validate splits if provided
    if (hasSplits) {
      this.validateSplits(splits, createTransactionDto.amount);
    }

    // Auto-assign category from payee's default category if not provided (only for non-split transactions)
    let categoryId = transactionData.categoryId;
    if (!hasSplits && !categoryId && transactionData.payeeId) {
      try {
        const payee = await this.payeesService.findOne(userId, transactionData.payeeId);
        if (payee.defaultCategoryId) {
          categoryId = payee.defaultCategoryId;
        }
      } catch (error) {
        // If payee not found or error, continue without category
      }
    }

    const transaction = this.transactionsRepository.create({
      ...transactionData,
      categoryId: hasSplits ? null : categoryId, // Split transactions don't have a category on parent
      isSplit: hasSplits,
      userId,
      exchangeRate: transactionData.exchangeRate || 1,
    });

    const savedTransaction = await this.transactionsRepository.save(transaction);

    // Create splits if provided
    if (hasSplits) {
      await this.createSplits(savedTransaction.id, splits);
    }

    // Update account balance
    await this.accountsService.updateBalance(
      createTransactionDto.accountId,
      Number(createTransactionDto.amount),
    );

    // Return transaction with splits
    return this.findOne(userId, savedTransaction.id);
  }

  /**
   * Validate that splits sum to the transaction amount
   */
  private validateSplits(splits: CreateTransactionSplitDto[], transactionAmount: number): void {
    if (splits.length < 2) {
      throw new BadRequestException('Split transactions must have at least 2 splits');
    }

    const splitsSum = splits.reduce((sum, split) => sum + Number(split.amount), 0);
    const roundedSum = Math.round(splitsSum * 10000) / 10000;
    const roundedAmount = Math.round(Number(transactionAmount) * 10000) / 10000;

    if (roundedSum !== roundedAmount) {
      throw new BadRequestException(
        `Split amounts (${roundedSum}) must equal transaction amount (${roundedAmount})`,
      );
    }

    // Validate each split has non-zero amount
    for (const split of splits) {
      if (split.amount === 0) {
        throw new BadRequestException('Split amounts cannot be zero');
      }
    }
  }

  /**
   * Create splits for a transaction
   */
  private async createSplits(
    transactionId: string,
    splits: CreateTransactionSplitDto[],
  ): Promise<TransactionSplit[]> {
    const splitEntities = splits.map((split) =>
      this.splitsRepository.create({
        transactionId,
        categoryId: split.categoryId || null,
        amount: split.amount,
        memo: split.memo || null,
      }),
    );

    return this.splitsRepository.save(splitEntities);
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
      .leftJoinAndSelect('transaction.payee', 'payee')
      .leftJoinAndSelect('transaction.category', 'category')
      .leftJoinAndSelect('transaction.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
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
      relations: ['payee', 'category', 'splits', 'splits.category'],
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

    const { splits, ...updateData } = updateTransactionDto;

    // If account is being changed, verify new account belongs to user
    if (updateData.accountId && updateData.accountId !== oldAccountId) {
      await this.accountsService.findOne(userId, updateData.accountId);
    }

    // Handle splits if provided (check both presence and if it's an array)
    if (splits !== undefined) {
      if (Array.isArray(splits) && splits.length > 0) {
        // Validate splits against the new amount or existing amount
        const amount = updateData.amount ?? transaction.amount;
        this.validateSplits(splits, amount);

        // Delete existing splits and create new ones
        await this.splitsRepository.delete({ transactionId: id });
        await this.createSplits(id, splits);
      } else if (Array.isArray(splits) && splits.length === 0) {
        // Explicitly empty array - convert back to simple transaction
        await this.splitsRepository.delete({ transactionId: id });
        await this.transactionsRepository.update(id, { isSplit: false });
      }
      // If splits is undefined, don't touch existing splits
    }

    // Build the update object, only including fields that were provided
    const transactionUpdateData: Partial<Transaction> = {};

    if ('accountId' in updateData) transactionUpdateData.accountId = updateData.accountId;
    if ('transactionDate' in updateData) transactionUpdateData.transactionDate = updateData.transactionDate as any;
    if ('payeeId' in updateData) transactionUpdateData.payeeId = updateData.payeeId ?? null;
    if ('payeeName' in updateData) transactionUpdateData.payeeName = updateData.payeeName ?? null;
    if ('categoryId' in updateData) transactionUpdateData.categoryId = updateData.categoryId ?? null;
    if ('amount' in updateData) transactionUpdateData.amount = updateData.amount;
    if ('currencyCode' in updateData) transactionUpdateData.currencyCode = updateData.currencyCode;
    if ('exchangeRate' in updateData) transactionUpdateData.exchangeRate = updateData.exchangeRate;
    if ('description' in updateData) transactionUpdateData.description = updateData.description ?? null;
    if ('referenceNumber' in updateData) transactionUpdateData.referenceNumber = updateData.referenceNumber ?? null;
    if ('isCleared' in updateData) transactionUpdateData.isCleared = updateData.isCleared;
    if ('isReconciled' in updateData) transactionUpdateData.isReconciled = updateData.isReconciled;
    if ('reconciledDate' in updateData) transactionUpdateData.reconciledDate = updateData.reconciledDate as any;

    // If we have splits, ensure categoryId is null on parent
    if (splits && splits.length > 0) {
      transactionUpdateData.categoryId = null;
      transactionUpdateData.isSplit = true;
    }

    // Use update() instead of save() to bypass TypeORM's relation tracking issues
    if (Object.keys(transactionUpdateData).length > 0) {
      await this.transactionsRepository.update(id, transactionUpdateData);
    }

    // Fetch the updated transaction
    const savedTransaction = await this.findOne(userId, id);

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

  /**
   * Get splits for a transaction
   */
  async getSplits(userId: string, transactionId: string): Promise<TransactionSplit[]> {
    // Verify user has access to the transaction
    await this.findOne(userId, transactionId);

    return this.splitsRepository.find({
      where: { transactionId },
      relations: ['category'],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Update all splits for a transaction (atomic replacement)
   */
  async updateSplits(
    userId: string,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
  ): Promise<TransactionSplit[]> {
    const transaction = await this.findOne(userId, transactionId);

    // Validate splits
    this.validateSplits(splits, transaction.amount);

    // Delete existing splits
    await this.splitsRepository.delete({ transactionId });

    // Create new splits
    const newSplits = await this.createSplits(transactionId, splits);

    // Update transaction to be a split transaction
    await this.transactionsRepository.update(transactionId, {
      isSplit: true,
      categoryId: null, // Split transactions don't have a category on parent
    });

    return newSplits;
  }

  /**
   * Add a single split to an existing transaction
   */
  async addSplit(
    userId: string,
    transactionId: string,
    splitDto: CreateTransactionSplitDto,
  ): Promise<TransactionSplit> {
    const transaction = await this.findOne(userId, transactionId);

    // Get existing splits
    const existingSplits = await this.getSplits(userId, transactionId);
    const existingTotal = existingSplits.reduce((sum, s) => sum + Number(s.amount), 0);
    const newTotal = existingTotal + Number(splitDto.amount);

    // Check if new split would exceed transaction amount
    const roundedNewTotal = Math.round(newTotal * 10000) / 10000;
    const roundedTransactionAmount = Math.round(Number(transaction.amount) * 10000) / 10000;

    if (Math.abs(roundedNewTotal) > Math.abs(roundedTransactionAmount)) {
      throw new BadRequestException(
        `Adding this split would exceed the transaction amount. ` +
        `Current total: ${existingTotal}, New split: ${splitDto.amount}, ` +
        `Transaction amount: ${transaction.amount}`,
      );
    }

    const split = this.splitsRepository.create({
      transactionId,
      categoryId: splitDto.categoryId || null,
      amount: splitDto.amount,
      memo: splitDto.memo || null,
    });

    const savedSplit = await this.splitsRepository.save(split);

    // Update transaction to be a split if it has 2+ splits now
    const totalSplits = existingSplits.length + 1;
    if (totalSplits >= 2 && !transaction.isSplit) {
      await this.transactionsRepository.update(transactionId, {
        isSplit: true,
        categoryId: null,
      });
    }

    const splitWithCategory = await this.splitsRepository.findOne({
      where: { id: savedSplit.id },
      relations: ['category'],
    });

    if (!splitWithCategory) {
      throw new NotFoundException(`Split with ID ${savedSplit.id} not found`);
    }

    return splitWithCategory;
  }

  /**
   * Remove a split from a transaction
   */
  async removeSplit(
    userId: string,
    transactionId: string,
    splitId: string,
  ): Promise<void> {
    // Verify user has access to the transaction
    await this.findOne(userId, transactionId);

    const split = await this.splitsRepository.findOne({
      where: { id: splitId, transactionId },
    });

    if (!split) {
      throw new NotFoundException(`Split with ID ${splitId} not found`);
    }

    await this.splitsRepository.remove(split);

    // Check remaining splits
    const remainingSplits = await this.getSplits(userId, transactionId);
    if (remainingSplits.length < 2) {
      // Convert back to simple transaction if less than 2 splits
      // If 1 split remains, we could optionally move its category to the parent
      if (remainingSplits.length === 1) {
        await this.transactionsRepository.update(transactionId, {
          isSplit: false,
          categoryId: remainingSplits[0].categoryId,
        });
        await this.splitsRepository.remove(remainingSplits[0]);
      } else {
        await this.transactionsRepository.update(transactionId, {
          isSplit: false,
        });
      }
    }
  }
}
