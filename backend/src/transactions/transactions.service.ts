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
import { Category } from '../categories/entities/category.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { CreateTransactionSplitDto } from './dto/create-transaction-split.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { AccountsService } from '../accounts/accounts.service';
import { PayeesService } from '../payees/payees.service';

export interface PaginatedTransactions {
  data: Transaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
  /** Starting balance for running balance calculation (only set when filtering by single account) */
  startingBalance?: number;
}

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private accountsService: AccountsService,
    private payeesService: PayeesService,
  ) {}

  /**
   * Get all category IDs including subcategories for a given category
   */
  private async getCategoryIdsWithChildren(
    userId: string,
    categoryId: string,
  ): Promise<string[]> {
    const categories = await this.categoriesRepository.find({
      where: { userId },
      select: ['id', 'parentId'],
    });

    const result: string[] = [categoryId];
    const addChildren = (parentId: string) => {
      for (const cat of categories) {
        if (cat.parentId === parentId) {
          result.push(cat.id);
          addChildren(cat.id);
        }
      }
    };
    addChildren(categoryId);

    return result;
  }

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
   * Find all transactions for a user with optional filters and pagination
   */
  async findAll(
    userId: string,
    accountId?: string,
    startDate?: string,
    endDate?: string,
    categoryId?: string,
    payeeId?: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginatedTransactions> {
    // Enforce limits
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.account', 'account')
      .leftJoinAndSelect('transaction.payee', 'payee')
      .leftJoinAndSelect('transaction.category', 'category')
      .leftJoinAndSelect('transaction.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .where('transaction.userId = :userId', { userId })
      .orderBy('transaction.transactionDate', 'DESC')
      .addOrderBy('transaction.createdAt', 'DESC')
      .addOrderBy('transaction.id', 'DESC');

    if (accountId) {
      queryBuilder.andWhere('transaction.accountId = :accountId', { accountId });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :endDate', { endDate });
    }

    if (categoryId) {
      if (categoryId === 'uncategorized') {
        // Match transactions without a category (not split, not transfer)
        queryBuilder.andWhere(
          '(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false)',
        );
      } else if (categoryId === 'transfer') {
        // Match transfer transactions
        queryBuilder.andWhere('transaction.isTransfer = true');
      } else {
        // Get category IDs including all subcategories
        const categoryIds = await this.getCategoryIdsWithChildren(
          userId,
          categoryId,
        );
        // Match transactions where:
        // 1. The transaction has this category or any subcategory directly, OR
        // 2. Any of the transaction's splits have this category or any subcategory
        queryBuilder.andWhere(
          '(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))',
          { categoryIds },
        );
      }
    }

    if (payeeId) {
      queryBuilder.andWhere('transaction.payeeId = :payeeId', { payeeId });
    }

    // Get total count and paginated results
    const [data, total] = await queryBuilder
      .skip(skip)
      .take(safeLimit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / safeLimit);

    // Calculate starting balance for running balance column when viewing a single account
    // startingBalance = balance AFTER the first (newest) transaction on this page
    let startingBalance: number | undefined;
    if (accountId && data.length > 0) {
      const account = await this.accountsService.findOne(userId, accountId);
      const currentBalance = Number(account.currentBalance);

      if (safePage === 1) {
        // Page 1: startingBalance = currentBalance (balance after newest tx overall)
        startingBalance = currentBalance;
      } else {
        // For other pages, sum all transactions newer than the first tx on this page
        // startingBalance = currentBalance - sum(txs newer than first tx)
        const firstTxOnPage = data[0];

        // Sum all transactions that appear BEFORE the first transaction on this page.
        // newerSum = sum(txs with date > firstDate) + sum(txs with date = firstDate but NOT on this page)
        const pageIds = data.map(tx => tx.id);
        const firstDate = firstTxOnPage.transactionDate;

        // Sum of transactions with date strictly greater than first tx's date
        const sumDateGreaterResult = await this.transactionsRepository
          .createQueryBuilder('transaction')
          .select('SUM(transaction.amount)', 'sum')
          .where('transaction.userId = :userId', { userId })
          .andWhere('transaction.accountId = :accountId', { accountId })
          .andWhere('transaction.transactionDate > :firstDate', { firstDate })
          .getRawOne();

        // Sum of transactions with same date but NOT on this page (on earlier pages)
        const sumSameDateNotOnPageResult = await this.transactionsRepository
          .createQueryBuilder('transaction')
          .select('SUM(transaction.amount)', 'sum')
          .where('transaction.userId = :userId', { userId })
          .andWhere('transaction.accountId = :accountId', { accountId })
          .andWhere('transaction.transactionDate = :firstDate', { firstDate })
          .andWhere('transaction.id NOT IN (:...pageIds)', { pageIds })
          .getRawOne();

        const sumDateGreater = Number(sumDateGreaterResult?.sum) || 0;
        const sumSameDateNotOnPage = Number(sumSameDateNotOnPageResult?.sum) || 0;
        startingBalance = currentBalance - sumDateGreater - sumSameDateNotOnPage;
      }
    }

    return {
      data,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages,
        hasMore: safePage < totalPages,
      },
      startingBalance,
    };
  }

  /**
   * Find a single transaction by ID
   */
  async findOne(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.transactionsRepository.findOne({
      where: { id },
      relations: ['account', 'payee', 'category', 'splits', 'splits.category', 'linkedTransaction', 'linkedTransaction.account'],
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
    const now = new Date();
    transaction.reconciledDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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
   * Get transaction summary statistics using efficient aggregation
   */
  async getSummary(
    userId: string,
    accountId?: string,
    startDate?: string,
    endDate?: string,
    categoryId?: string,
    payeeId?: string,
  ): Promise<{
    totalIncome: number;
    totalExpenses: number;
    netCashFlow: number;
    transactionCount: number;
  }> {
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transaction')
      .select('SUM(CASE WHEN transaction.amount > 0 THEN transaction.amount ELSE 0 END)', 'totalIncome')
      .addSelect('SUM(CASE WHEN transaction.amount < 0 THEN ABS(transaction.amount) ELSE 0 END)', 'totalExpenses')
      .addSelect('COUNT(*)', 'transactionCount')
      .where('transaction.userId = :userId', { userId });

    if (accountId) {
      queryBuilder.andWhere('transaction.accountId = :accountId', { accountId });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :endDate', { endDate });
    }

    if (categoryId) {
      if (categoryId === 'uncategorized') {
        // Match transactions without a category (not split, not transfer)
        queryBuilder.andWhere(
          '(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false)',
        );
      } else if (categoryId === 'transfer') {
        // Match transfer transactions
        queryBuilder.andWhere('transaction.isTransfer = true');
      } else {
        // Get category IDs including all subcategories
        const categoryIds = await this.getCategoryIdsWithChildren(
          userId,
          categoryId,
        );
        // Need to join splits to match split transactions with this category
        queryBuilder
          .leftJoin('transaction.splits', 'splits')
          .andWhere(
            '(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))',
            { categoryIds },
          );
      }
    }

    if (payeeId) {
      queryBuilder.andWhere('transaction.payeeId = :payeeId', { payeeId });
    }

    const result = await queryBuilder.getRawOne();

    const totalIncome = Number(result.totalIncome) || 0;
    const totalExpenses = Number(result.totalExpenses) || 0;

    return {
      totalIncome,
      totalExpenses,
      netCashFlow: totalIncome - totalExpenses,
      transactionCount: Number(result.transactionCount) || 0,
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

  // ==================== Transfer Methods ====================

  /**
   * Create a transfer between two accounts
   * This creates two linked transactions: a withdrawal from the source account
   * and a deposit to the destination account
   */
  async createTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
  ): Promise<TransferResult> {
    const {
      fromAccountId,
      toAccountId,
      transactionDate,
      amount,
      fromCurrencyCode,
      toCurrencyCode,
      exchangeRate = 1,
      description,
      referenceNumber,
      isCleared = false,
    } = createTransferDto;

    // Validate that accounts are different
    if (fromAccountId === toAccountId) {
      throw new BadRequestException('Source and destination accounts must be different');
    }

    // Validate amount is positive
    if (amount <= 0) {
      throw new BadRequestException('Transfer amount must be positive');
    }

    // Verify both accounts belong to user
    const fromAccount = await this.accountsService.findOne(userId, fromAccountId);
    const toAccount = await this.accountsService.findOne(userId, toAccountId);

    // Calculate the destination amount using exchange rate
    const toAmount = Math.round(amount * exchangeRate * 10000) / 10000;
    const destinationCurrency = toCurrencyCode || fromCurrencyCode;

    // Create the withdrawal transaction (from account - negative amount)
    const fromTransaction = this.transactionsRepository.create({
      userId,
      accountId: fromAccountId,
      transactionDate: transactionDate as any,
      amount: -amount, // Negative for withdrawal
      currencyCode: fromCurrencyCode,
      exchangeRate: 1,
      description: description || `Transfer to ${toAccount.name}`,
      referenceNumber,
      isCleared,
      isTransfer: true,
      payeeName: `Transfer to ${toAccount.name}`,
    });

    // Create the deposit transaction (to account - positive amount)
    const toTransaction = this.transactionsRepository.create({
      userId,
      accountId: toAccountId,
      transactionDate: transactionDate as any,
      amount: toAmount, // Positive for deposit
      currencyCode: destinationCurrency,
      exchangeRate: exchangeRate,
      description: description || `Transfer from ${fromAccount.name}`,
      referenceNumber,
      isCleared,
      isTransfer: true,
      payeeName: `Transfer from ${fromAccount.name}`,
    });

    // Save both transactions
    const savedFromTransaction = await this.transactionsRepository.save(fromTransaction);
    const savedToTransaction = await this.transactionsRepository.save(toTransaction);

    // Link the transactions to each other
    await this.transactionsRepository.update(savedFromTransaction.id, {
      linkedTransactionId: savedToTransaction.id,
    });
    await this.transactionsRepository.update(savedToTransaction.id, {
      linkedTransactionId: savedFromTransaction.id,
    });

    // Update account balances
    await this.accountsService.updateBalance(fromAccountId, -amount);
    await this.accountsService.updateBalance(toAccountId, toAmount);

    // Return both transactions with full relations
    return {
      fromTransaction: await this.findOne(userId, savedFromTransaction.id),
      toTransaction: await this.findOne(userId, savedToTransaction.id),
    };
  }

  /**
   * Get the linked transfer transaction
   */
  async getLinkedTransaction(userId: string, transactionId: string): Promise<Transaction | null> {
    const transaction = await this.findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      return null;
    }

    try {
      return await this.findOne(userId, transaction.linkedTransactionId);
    } catch (error) {
      // Linked transaction not found or not accessible
      return null;
    }
  }

  /**
   * Delete a transfer (deletes both linked transactions)
   */
  async removeTransfer(userId: string, transactionId: string): Promise<void> {
    const transaction = await this.findOne(userId, transactionId);

    if (!transaction.isTransfer) {
      throw new BadRequestException('Transaction is not a transfer');
    }

    // Get the linked transaction
    const linkedTransaction = transaction.linkedTransactionId
      ? await this.transactionsRepository.findOne({
          where: { id: transaction.linkedTransactionId },
        })
      : null;

    // Revert the balance changes
    await this.accountsService.updateBalance(
      transaction.accountId,
      -Number(transaction.amount),
    );

    if (linkedTransaction) {
      await this.accountsService.updateBalance(
        linkedTransaction.accountId,
        -Number(linkedTransaction.amount),
      );
      // Remove linked transaction first (to avoid FK issues if any)
      await this.transactionsRepository.remove(linkedTransaction);
    }

    // Remove the main transaction
    await this.transactionsRepository.remove(transaction);
  }

  /**
   * Update a transfer - updates both linked transactions
   */
  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<CreateTransferDto>,
  ): Promise<TransferResult> {
    const transaction = await this.findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      throw new BadRequestException('Transaction is not a transfer');
    }

    const linkedTransaction = await this.findOne(userId, transaction.linkedTransactionId);

    // Determine which is the "from" (negative amount) and "to" (positive amount) transaction
    const isFromTransaction = Number(transaction.amount) < 0;
    const fromTransaction = isFromTransaction ? transaction : linkedTransaction;
    const toTransaction = isFromTransaction ? linkedTransaction : transaction;

    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);

    // Update values
    const newAmount = updateDto.amount ?? oldFromAmount;
    const newExchangeRate = updateDto.exchangeRate ?? toTransaction.exchangeRate;
    const newToAmount = Math.round(newAmount * newExchangeRate * 10000) / 10000;

    // Update from transaction
    const fromUpdateData: Partial<Transaction> = {};
    if (updateDto.transactionDate) fromUpdateData.transactionDate = updateDto.transactionDate as any;
    if (updateDto.amount) fromUpdateData.amount = -newAmount;
    if (updateDto.description !== undefined) fromUpdateData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined) fromUpdateData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.isCleared !== undefined) fromUpdateData.isCleared = updateDto.isCleared;
    if (updateDto.fromCurrencyCode) fromUpdateData.currencyCode = updateDto.fromCurrencyCode;

    if (Object.keys(fromUpdateData).length > 0) {
      await this.transactionsRepository.update(fromTransaction.id, fromUpdateData);
    }

    // Update to transaction
    const toUpdateData: Partial<Transaction> = {};
    if (updateDto.transactionDate) toUpdateData.transactionDate = updateDto.transactionDate as any;
    if (updateDto.amount || updateDto.exchangeRate) toUpdateData.amount = newToAmount;
    if (updateDto.description !== undefined) toUpdateData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined) toUpdateData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.isCleared !== undefined) toUpdateData.isCleared = updateDto.isCleared;
    if (updateDto.toCurrencyCode) toUpdateData.currencyCode = updateDto.toCurrencyCode;
    if (updateDto.exchangeRate) toUpdateData.exchangeRate = updateDto.exchangeRate;

    if (Object.keys(toUpdateData).length > 0) {
      await this.transactionsRepository.update(toTransaction.id, toUpdateData);
    }

    // Update balances if amount changed
    if (updateDto.amount || updateDto.exchangeRate) {
      // Revert old balances
      await this.accountsService.updateBalance(fromTransaction.accountId, oldFromAmount);
      await this.accountsService.updateBalance(toTransaction.accountId, -oldToAmount);
      // Apply new balances
      await this.accountsService.updateBalance(fromTransaction.accountId, -newAmount);
      await this.accountsService.updateBalance(toTransaction.accountId, newToAmount);
    }

    return {
      fromTransaction: await this.findOne(userId, fromTransaction.id),
      toTransaction: await this.findOne(userId, toTransaction.id),
    };
  }
}
