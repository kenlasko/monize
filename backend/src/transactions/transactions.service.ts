import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Transaction, TransactionStatus } from './entities/transaction.entity';
import { TransactionSplit } from './entities/transaction-split.entity';
import { Category } from '../categories/entities/category.entity';
import { InvestmentTransaction } from '../securities/entities/investment-transaction.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { CreateTransactionSplitDto } from './dto/create-transaction-split.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { AccountsService } from '../accounts/accounts.service';
import { PayeesService } from '../payees/payees.service';
import { NetWorthService } from '../net-worth/net-worth.service';

export interface TransactionWithInvestmentLink extends Transaction {
  /** ID of the linked investment transaction (if this is a cash transaction for an investment) */
  linkedInvestmentTransactionId?: string | null;
}

export interface PaginatedTransactions {
  data: TransactionWithInvestmentLink[];
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
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private payeesService: PayeesService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
  ) {}

  private triggerNetWorthRecalc(accountId: string, userId: string): void {
    this.netWorthService.recalculateAccount(userId, accountId).catch((err) =>
      this.logger.warn(
        `Net worth recalc failed for account ${accountId}: ${err.message}`,
      ),
    );
  }

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
      await this.createSplits(
        savedTransaction.id,
        splits,
        userId,
        createTransactionDto.accountId,
        new Date(createTransactionDto.transactionDate),
        transactionData.payeeName,
      );
    }

    // Update account balance only if not VOID
    if (savedTransaction.status !== TransactionStatus.VOID) {
      await this.accountsService.updateBalance(
        createTransactionDto.accountId,
        Number(createTransactionDto.amount),
      );
    }

    this.triggerNetWorthRecalc(createTransactionDto.accountId, userId);

    // Return transaction with splits
    return this.findOne(userId, savedTransaction.id);
  }

  /**
   * Delete transfer splits' linked transactions and revert their balances
   */
  private async deleteTransferSplitLinkedTransactions(transactionId: string): Promise<void> {
    // Find all splits for this transaction that have linked transactions
    const transferSplits = await this.splitsRepository.find({
      where: { transactionId },
      relations: ['linkedTransaction'],
    });

    for (const split of transferSplits) {
      if (split.linkedTransactionId && split.transferAccountId) {
        // Revert the balance change in the target account
        // The linked transaction has the inverse amount, so we need to subtract it
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

  /**
   * Validate that splits sum to the transaction amount
   */
  private validateSplits(splits: CreateTransactionSplitDto[], transactionAmount: number): void {
    // Allow single split for transfers (has transferAccountId)
    const isTransfer = splits.length === 1 && splits[0].transferAccountId;

    if (splits.length < 2 && !isTransfer) {
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
   * For transfer splits, also creates linked transactions in target accounts
   */
  private async createSplits(
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

      // For transfer splits, create linked transaction in target account
      if (split.transferAccountId && userId && sourceAccountId) {
        const targetAccount = await this.accountsService.findOne(userId, split.transferAccountId);
        const sourceAccount = await this.accountsService.findOne(userId, sourceAccountId);

        // Create the linked transaction in the target account (inverse amount)
        const linkedTransaction = this.transactionsRepository.create({
          userId,
          accountId: split.transferAccountId,
          transactionDate: transactionDate as any,
          amount: -split.amount, // Inverse: if split is -40 (withdrawal), target gets +40 (deposit)
          currencyCode: targetAccount.currencyCode,
          exchangeRate: 1,
          description: split.memo || null,
          isTransfer: true,
          payeeName: parentPayeeName || `Transfer from ${sourceAccount.name}`,
        });

        const savedLinkedTransaction = await this.transactionsRepository.save(linkedTransaction);

        // Update the split with the linked transaction ID
        await this.splitsRepository.update(savedSplit.id, {
          linkedTransactionId: savedLinkedTransaction.id,
        });

        // Also set linkedTransactionId on the created transaction pointing back to the parent
        // This allows traversing from the target account transaction back to the source splits
        await this.transactionsRepository.update(savedLinkedTransaction.id, {
          linkedTransactionId: transactionId,
        });

        // Update target account balance
        await this.accountsService.updateBalance(split.transferAccountId, -split.amount);

        savedSplit.linkedTransactionId = savedLinkedTransaction.id;
      }

      savedSplits.push(savedSplit);
    }

    return savedSplits;
  }

  /**
   * Find all transactions for a user with optional filters and pagination
   */
  async findAll(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    page: number = 1,
    limit: number = 50,
    includeInvestmentBrokerage: boolean = false,
    search?: string,
    targetTransactionId?: string,
  ): Promise<PaginatedTransactions> {
    // Enforce limits
    // Allow higher limits for reports that need to aggregate all data
    let safePage = Math.max(1, page);
    const safeLimit = Math.min(100000, Math.max(1, limit));

    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.account', 'account')
      .leftJoinAndSelect('transaction.payee', 'payee')
      .leftJoinAndSelect('transaction.category', 'category')
      .leftJoinAndSelect('transaction.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .leftJoinAndSelect('splits.transferAccount', 'splitTransferAccount')
      .leftJoinAndSelect('transaction.linkedTransaction', 'linkedTransaction')
      .leftJoinAndSelect('linkedTransaction.account', 'linkedAccount')
      .leftJoinAndSelect('linkedTransaction.splits', 'linkedSplits')
      .leftJoinAndSelect('linkedSplits.category', 'linkedSplitCategory')
      .leftJoinAndSelect('linkedSplits.transferAccount', 'linkedSplitTransferAccount')
      .where('transaction.userId = :userId', { userId })
      .orderBy('transaction.transactionDate', 'DESC')
      .addOrderBy('transaction.createdAt', 'DESC')
      .addOrderBy('transaction.id', 'DESC');

    // Exclude investment brokerage accounts unless explicitly requested
    if (!includeInvestmentBrokerage) {
      queryBuilder.andWhere(
        "(account.accountSubType IS NULL OR account.accountSubType != 'INVESTMENT_BROKERAGE')",
      );
    }

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere('transaction.accountId IN (:...accountIds)', { accountIds });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :endDate', { endDate });
    }

    if (categoryIds && categoryIds.length > 0) {
      // Check for special category filters
      const hasUncategorized = categoryIds.includes('uncategorized');
      const hasTransfer = categoryIds.includes('transfer');
      const regularCategoryIds = categoryIds.filter(
        (id) => id !== 'uncategorized' && id !== 'transfer',
      );

      const conditions: string[] = [];

      if (hasUncategorized) {
        conditions.push(
          '(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false)',
        );
      }

      if (hasTransfer) {
        conditions.push('transaction.isTransfer = true');
      }

      if (regularCategoryIds.length > 0) {
        // Get all category IDs including subcategories for each selected category
        const allCategoryIds: string[] = [];
        for (const catId of regularCategoryIds) {
          const idsWithChildren = await this.getCategoryIdsWithChildren(userId, catId);
          allCategoryIds.push(...idsWithChildren);
        }
        const uniqueCategoryIds = [...new Set(allCategoryIds)];

        if (uniqueCategoryIds.length > 0) {
          conditions.push(
            '(transaction.categoryId IN (:...filterCategoryIds) OR splits.categoryId IN (:...filterCategoryIds))',
          );
          queryBuilder.setParameter('filterCategoryIds', uniqueCategoryIds);
        }
      }

      if (conditions.length > 0) {
        queryBuilder.andWhere(`(${conditions.join(' OR ')})`);
      }
    }

    if (payeeIds && payeeIds.length > 0) {
      queryBuilder.andWhere('transaction.payeeId IN (:...payeeIds)', { payeeIds });
    }

    if (search && search.trim()) {
      const searchPattern = `%${search.trim()}%`;
      queryBuilder.andWhere(
        '(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)',
        { search: searchPattern },
      );
    }

    // If targetTransactionId is provided, calculate which page it's on
    if (targetTransactionId) {
      try {
        // First, get the target transaction's date and createdAt for comparison
        const targetTx = await this.transactionsRepository.findOne({
          where: { id: targetTransactionId, userId },
          select: ['id', 'transactionDate', 'createdAt'],
        });

        if (targetTx) {
          // Count how many transactions come before this one in the sorted order
          // Sorted by: transactionDate DESC, createdAt DESC, id DESC
          const countQuery = this.transactionsRepository
            .createQueryBuilder('t')
            .leftJoin('t.account', 'a')
            .leftJoin('t.splits', 's')
            .where('t.userId = :userId', { userId });

          // Apply the same filters as the main query
          if (!includeInvestmentBrokerage) {
            countQuery.andWhere(
              "(a.accountSubType IS NULL OR a.accountSubType != 'INVESTMENT_BROKERAGE')",
            );
          }
          if (accountIds && accountIds.length > 0) {
            countQuery.andWhere('t.accountId IN (:...accountIds)', { accountIds });
          }
          if (startDate) {
            countQuery.andWhere('t.transactionDate >= :startDate', { startDate });
          }
          if (endDate) {
            countQuery.andWhere('t.transactionDate <= :endDate', { endDate });
          }
          if (payeeIds && payeeIds.length > 0) {
            countQuery.andWhere('t.payeeId IN (:...payeeIds)', { payeeIds });
          }
          if (search && search.trim()) {
            const searchPattern = `%${search.trim()}%`;
            countQuery.andWhere(
              '(t.description ILIKE :search OR t.payeeName ILIKE :search OR s.memo ILIKE :search)',
              { search: searchPattern },
            );
          }
          // Note: Category filters are complex and would need to be replicated here
          // For simplicity, we'll skip them in the count query since they're less common

          // Count transactions that come BEFORE the target in sort order
          // (newer date, or same date but newer createdAt, or same both but higher id)
          countQuery.andWhere(
            `(t.transactionDate > :targetDate
              OR (t.transactionDate = :targetDate AND t.createdAt > :targetCreatedAt)
              OR (t.transactionDate = :targetDate AND t.createdAt = :targetCreatedAt AND t.id > :targetId))`,
            {
              targetDate: targetTx.transactionDate,
              targetCreatedAt: targetTx.createdAt,
              targetId: targetTx.id,
            },
          );

          const countBefore = await countQuery.getCount();
          // Page number is 1-indexed: if 0 transactions come before, it's on page 1
          // If 50 transactions come before (with limit 50), it's on page 2
          safePage = Math.floor(countBefore / safeLimit) + 1;
        }
      } catch (error) {
        // If target transaction lookup fails, fall back to the requested page
        console.error('Failed to find target transaction page:', error);
      }
    }

    const skip = (safePage - 1) * safeLimit;

    // Get total count and paginated results
    const [data, total] = await queryBuilder
      .skip(skip)
      .take(safeLimit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / safeLimit);

    // Calculate starting balance for running balance column when viewing a single account
    // startingBalance = balance AFTER the first (newest) transaction on this page
    let startingBalance: number | undefined;
    const singleAccountId = accountIds?.length === 1 ? accountIds[0] : undefined;
    if (singleAccountId && data.length > 0) {
      const account = await this.accountsService.findOne(userId, singleAccountId);
      const currentBalance = Number(account.currentBalance) || 0;

      if (safePage === 1) {
        // Page 1: startingBalance = currentBalance (balance after newest tx overall)
        startingBalance = currentBalance;
      } else {
        // For other pages, we need to sum the transactions on all previous pages.
        // skip = (page - 1) * limit = number of transactions on previous pages
        // Get the IDs of those transactions, then sum their amounts.
        const previousPagesQuery = this.transactionsRepository
          .createQueryBuilder('t')
          .select('t.id')
          .where('t.userId = :userId', { userId })
          .andWhere('t.accountId = :singleAccountId', { singleAccountId })
          .orderBy('t.transactionDate', 'DESC')
          .addOrderBy('t.createdAt', 'DESC')
          .addOrderBy('t.id', 'DESC')
          .limit(skip);

        const sumResult = await this.transactionsRepository
          .createQueryBuilder('transaction')
          .select('SUM(transaction.amount)', 'sum')
          .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
          .setParameters(previousPagesQuery.getParameters())
          .getRawOne();

        const sumBefore = Number(sumResult?.sum) || 0;
        startingBalance = currentBalance - sumBefore;
      }
    }

    // Enrich transactions with linked investment transaction IDs
    // This allows the frontend to know if a transaction is linked to an investment transaction
    const transactionIds = data.map((tx) => tx.id);
    let investmentLinkMap = new Map<string, string>();

    if (transactionIds.length > 0) {
      const linkedInvestmentTxs = await this.investmentTransactionsRepository.find({
        where: { transactionId: In(transactionIds) },
        select: ['id', 'transactionId'],
      });

      for (const invTx of linkedInvestmentTxs) {
        if (invTx.transactionId) {
          investmentLinkMap.set(invTx.transactionId, invTx.id);
        }
      }
    }

    // Add linkedInvestmentTransactionId to each transaction
    // Note: We need to explicitly include getter properties since spread doesn't copy them
    const enrichedData: TransactionWithInvestmentLink[] = data.map((tx) => ({
      ...tx,
      isCleared: tx.isCleared,
      isReconciled: tx.isReconciled,
      isVoid: tx.isVoid,
      linkedInvestmentTransactionId: investmentLinkMap.get(tx.id) || null,
    }));

    return {
      data: enrichedData,
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
      relations: ['account', 'payee', 'category', 'splits', 'splits.category', 'splits.transferAccount', 'linkedTransaction', 'linkedTransaction.account'],
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
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;

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

        // Clean up any linked transactions from old transfer splits
        await this.deleteTransferSplitLinkedTransactions(id);

        // Delete existing splits and create new ones
        await this.splitsRepository.delete({ transactionId: id });

        const accountId = updateData.accountId ?? transaction.accountId;
        const txDate = updateData.transactionDate ?? transaction.transactionDate;
        await this.createSplits(
          id,
          splits,
          userId,
          accountId,
          new Date(txDate),
          updateData.payeeName ?? transaction.payeeName,
        );
      } else if (Array.isArray(splits) && splits.length === 0) {
        // Clean up any linked transactions from old transfer splits
        await this.deleteTransferSplitLinkedTransactions(id);

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
    if ('status' in updateData) transactionUpdateData.status = updateData.status;
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
    const newStatus = savedTransaction.status;
    const isVoid = newStatus === TransactionStatus.VOID;

    // Balance update logic considering VOID status
    if (wasVoid && !isVoid) {
      // Was VOID, now not VOID - add the amount
      await this.accountsService.updateBalance(newAccountId, newAmount);
    } else if (!wasVoid && isVoid) {
      // Was not VOID, now VOID - remove the old amount
      await this.accountsService.updateBalance(oldAccountId, -oldAmount);
    } else if (!wasVoid && !isVoid) {
      // Neither was VOID - handle normal balance changes
      if (newAccountId !== oldAccountId) {
        // Transaction moved to different account
        await this.accountsService.updateBalance(oldAccountId, -oldAmount);
        await this.accountsService.updateBalance(newAccountId, newAmount);
      } else if (newAmount !== oldAmount) {
        // Amount changed in same account
        const balanceChange = newAmount - oldAmount;
        await this.accountsService.updateBalance(newAccountId, balanceChange);
      }
    }
    // If both were VOID and still VOID, no balance changes needed

    this.triggerNetWorthRecalc(newAccountId, userId);
    if (oldAccountId !== newAccountId) {
      this.triggerNetWorthRecalc(oldAccountId, userId);
    }

    return savedTransaction;
  }

  /**
   * Delete a transaction
   */
  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);

    // Clean up linked transactions from transfer splits
    if (transaction.isSplit) {
      await this.deleteTransferSplitLinkedTransactions(id);
    }

    // Check if this transaction is a linked transaction from a split
    // If so, we need to delete the entire parent transaction
    const parentSplit = await this.splitsRepository.findOne({
      where: { linkedTransactionId: id },
    });

    if (parentSplit) {
      const parentTransactionId = parentSplit.transactionId;
      const parentTransaction = await this.transactionsRepository.findOne({
        where: { id: parentTransactionId },
      });

      if (parentTransaction) {
        // Get all splits for the parent transaction
        const allSplits = await this.splitsRepository.find({
          where: { transactionId: parentTransactionId },
        });

        // Clean up all linked transactions from other transfer splits
        for (const split of allSplits) {
          if (split.linkedTransactionId && split.linkedTransactionId !== id) {
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

        // Delete all splits
        await this.splitsRepository.remove(allSplits);

        // Revert the parent transaction balance and delete it
        if (parentTransaction.status !== TransactionStatus.VOID) {
          await this.accountsService.updateBalance(
            parentTransaction.accountId,
            -Number(parentTransaction.amount),
          );
        }
        await this.transactionsRepository.remove(parentTransaction);
      }
    }

    // Revert the balance change only if not VOID
    if (transaction.status !== TransactionStatus.VOID) {
      await this.accountsService.updateBalance(
        transaction.accountId,
        -Number(transaction.amount),
      );
    }

    this.triggerNetWorthRecalc(transaction.accountId, userId);

    await this.transactionsRepository.remove(transaction);
  }

  /**
   * Update transaction status
   */
  async updateStatus(userId: string, id: string, status: TransactionStatus): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;
    const isVoid = status === TransactionStatus.VOID;

    // Handle balance changes when transitioning to/from VOID
    if (wasVoid && !isVoid) {
      // Was VOID, now not VOID - add the amount
      await this.accountsService.updateBalance(transaction.accountId, Number(transaction.amount));
    } else if (!wasVoid && isVoid) {
      // Was not VOID, now VOID - remove the amount
      await this.accountsService.updateBalance(transaction.accountId, -Number(transaction.amount));
    }

    // Update the status
    await this.transactionsRepository.update(id, { status });

    if (wasVoid !== isVoid) {
      this.triggerNetWorthRecalc(transaction.accountId, userId);
    }

    // Set reconciled date when marking as reconciled
    if (status === TransactionStatus.RECONCILED && oldStatus !== TransactionStatus.RECONCILED) {
      const now = new Date();
      const reconciledDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      await this.transactionsRepository.update(id, { reconciledDate });
    }

    return this.findOne(userId, id);
  }

  /**
   * Mark transaction as cleared (legacy method - uses status)
   */
  async markCleared(userId: string, id: string, isCleared: boolean): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);

    // Don't change if already reconciled or void
    if (transaction.status === TransactionStatus.RECONCILED || transaction.status === TransactionStatus.VOID) {
      throw new BadRequestException('Cannot change cleared status of reconciled or void transactions');
    }

    const newStatus = isCleared ? TransactionStatus.CLEARED : TransactionStatus.UNRECONCILED;
    return this.updateStatus(userId, id, newStatus);
  }

  /**
   * Reconcile a transaction
   */
  async reconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);

    if (transaction.status === TransactionStatus.RECONCILED) {
      throw new BadRequestException('Transaction is already reconciled');
    }

    if (transaction.status === TransactionStatus.VOID) {
      throw new BadRequestException('Cannot reconcile a void transaction');
    }

    return this.updateStatus(userId, id, TransactionStatus.RECONCILED);
  }

  /**
   * Unreconcile a transaction
   */
  async unreconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);

    if (transaction.status !== TransactionStatus.RECONCILED) {
      throw new BadRequestException('Transaction is not reconciled');
    }

    await this.transactionsRepository.update(id, {
      status: TransactionStatus.CLEARED,
      reconciledDate: null,
    });

    return this.findOne(userId, id);
  }

  /**
   * Get reconciliation data for an account
   * Returns unreconciled transactions and balance summaries
   */
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
    // Verify account belongs to user
    const account = await this.accountsService.findOne(userId, accountId);

    // Get all unreconciled/cleared transactions up to statement date (exclude VOID and RECONCILED)
    const transactions = await this.transactionsRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.payee', 'payee')
      .leftJoinAndSelect('transaction.category', 'category')
      .where('transaction.userId = :userId', { userId })
      .andWhere('transaction.accountId = :accountId', { accountId })
      .andWhere('transaction.status IN (:...statuses)', {
        statuses: [TransactionStatus.UNRECONCILED, TransactionStatus.CLEARED],
      })
      .andWhere('transaction.transactionDate <= :statementDate', { statementDate })
      .orderBy('transaction.transactionDate', 'ASC')
      .addOrderBy('transaction.createdAt', 'ASC')
      .getMany();

    // Calculate reconciled balance (sum of all reconciled transactions + opening balance)
    const reconciledResult = await this.transactionsRepository
      .createQueryBuilder('transaction')
      .select('SUM(transaction.amount)', 'sum')
      .where('transaction.userId = :userId', { userId })
      .andWhere('transaction.accountId = :accountId', { accountId })
      .andWhere('transaction.status = :status', { status: TransactionStatus.RECONCILED })
      .getRawOne();

    const reconciledSum = Number(reconciledResult?.sum) || 0;
    const reconciledBalance = Number(account.openingBalance) + reconciledSum;

    // Calculate cleared balance (reconciled + cleared but not reconciled)
    const clearedResult = await this.transactionsRepository
      .createQueryBuilder('transaction')
      .select('SUM(transaction.amount)', 'sum')
      .where('transaction.userId = :userId', { userId })
      .andWhere('transaction.accountId = :accountId', { accountId })
      .andWhere('transaction.status = :status', { status: TransactionStatus.CLEARED })
      .andWhere('transaction.transactionDate <= :statementDate', { statementDate })
      .getRawOne();

    const clearedSum = Number(clearedResult?.sum) || 0;
    const clearedBalance = reconciledBalance + clearedSum;

    // Difference between statement balance and cleared balance
    const difference = statementBalance - clearedBalance;

    return {
      transactions,
      reconciledBalance,
      clearedBalance,
      difference,
    };
  }

  /**
   * Bulk reconcile transactions
   * Marks all specified transactions as reconciled
   */
  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<{ reconciled: number }> {
    // Verify account belongs to user
    await this.accountsService.findOne(userId, accountId);

    if (transactionIds.length === 0) {
      return { reconciled: 0 };
    }

    // Verify all transactions belong to the user and account
    const transactions = await this.transactionsRepository
      .createQueryBuilder('transaction')
      .where('transaction.id IN (:...ids)', { ids: transactionIds })
      .andWhere('transaction.userId = :userId', { userId })
      .andWhere('transaction.accountId = :accountId', { accountId })
      .getMany();

    if (transactions.length !== transactionIds.length) {
      throw new BadRequestException(
        'Some transactions were not found or do not belong to the specified account',
      );
    }

    // Update all transactions to reconciled
    await this.transactionsRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        status: TransactionStatus.RECONCILED,
        reconciledDate: reconciledDate,
      })
      .where('id IN (:...ids)', { ids: transactionIds })
      .andWhere('userId = :userId', { userId })
      .execute();

    return { reconciled: transactions.length };
  }

  /**
   * Get transaction summary statistics using efficient aggregation
   */
  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
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

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere('transaction.accountId IN (:...accountIds)', { accountIds });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :endDate', { endDate });
    }

    if (categoryIds && categoryIds.length > 0) {
      // Check for special category filters
      const hasUncategorized = categoryIds.includes('uncategorized');
      const hasTransfer = categoryIds.includes('transfer');
      const regularCategoryIds = categoryIds.filter(
        (id) => id !== 'uncategorized' && id !== 'transfer',
      );

      const conditions: string[] = [];

      if (hasUncategorized) {
        conditions.push(
          '(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false)',
        );
      }

      if (hasTransfer) {
        conditions.push('transaction.isTransfer = true');
      }

      if (regularCategoryIds.length > 0) {
        // Get all category IDs including subcategories for each selected category
        const allCategoryIds: string[] = [];
        for (const catId of regularCategoryIds) {
          const idsWithChildren = await this.getCategoryIdsWithChildren(userId, catId);
          allCategoryIds.push(...idsWithChildren);
        }
        const uniqueCategoryIds = [...new Set(allCategoryIds)];

        if (uniqueCategoryIds.length > 0) {
          // Need to join splits to match split transactions with this category
          queryBuilder.leftJoin('transaction.splits', 'splits');
          conditions.push(
            '(transaction.categoryId IN (:...summaryCategoryIds) OR splits.categoryId IN (:...summaryCategoryIds))',
          );
          queryBuilder.setParameter('summaryCategoryIds', uniqueCategoryIds);
        }
      }

      if (conditions.length > 0) {
        queryBuilder.andWhere(`(${conditions.join(' OR ')})`);
      }
    }

    if (payeeIds && payeeIds.length > 0) {
      queryBuilder.andWhere('transaction.payeeId IN (:...payeeIds)', { payeeIds });
    }

    if (search && search.trim()) {
      const searchPattern = `%${search.trim()}%`;
      // Need to join splits if not already joined for search
      if (!categoryIds || categoryIds.length === 0) {
        queryBuilder.leftJoin('transaction.splits', 'splits');
      }
      queryBuilder.andWhere(
        '(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)',
        { search: searchPattern },
      );
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
      relations: ['category', 'transferAccount'],
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

    // Clean up any linked transactions from old transfer splits
    await this.deleteTransferSplitLinkedTransactions(transactionId);

    // Delete existing splits
    await this.splitsRepository.delete({ transactionId });

    // Create new splits
    const newSplits = await this.createSplits(
      transactionId,
      splits,
      userId,
      transaction.accountId,
      new Date(transaction.transactionDate),
      transaction.payeeName,
    );

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
      transferAccountId: splitDto.transferAccountId || null,
      amount: splitDto.amount,
      memo: splitDto.memo || null,
    });

    const savedSplit = await this.splitsRepository.save(split);

    // For transfer splits, create linked transaction in target account
    if (splitDto.transferAccountId) {
      const targetAccount = await this.accountsService.findOne(userId, splitDto.transferAccountId);
      const sourceAccount = await this.accountsService.findOne(userId, transaction.accountId);

      // Create the linked transaction in the target account (inverse amount)
      const linkedTransaction = this.transactionsRepository.create({
        userId,
        accountId: splitDto.transferAccountId,
        transactionDate: transaction.transactionDate,
        amount: -splitDto.amount, // Inverse amount
        currencyCode: targetAccount.currencyCode,
        exchangeRate: 1,
        description: splitDto.memo || null,
        isTransfer: true,
        payeeName: transaction.payeeName || `Transfer from ${sourceAccount.name}`,
      });

      const savedLinkedTransaction = await this.transactionsRepository.save(linkedTransaction);

      // Update the split with the linked transaction ID
      await this.splitsRepository.update(savedSplit.id, {
        linkedTransactionId: savedLinkedTransaction.id,
      });

      // Update target account balance
      await this.accountsService.updateBalance(splitDto.transferAccountId, -splitDto.amount);

      savedSplit.linkedTransactionId = savedLinkedTransaction.id;
    }

    // Update transaction to be a split if it has 2+ splits now
    const totalSplits = existingSplits.length + 1;
    if (totalSplits >= 2 && !transaction.isSplit) {
      await this.transactionsRepository.update(transactionId, {
        isSplit: true,
        categoryId: null,
      });
    }

    const splitWithRelations = await this.splitsRepository.findOne({
      where: { id: savedSplit.id },
      relations: ['category', 'transferAccount'],
    });

    if (!splitWithRelations) {
      throw new NotFoundException(`Split with ID ${savedSplit.id} not found`);
    }

    return splitWithRelations;
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

    // If this split has a linked transaction, clean it up
    if (split.linkedTransactionId && split.transferAccountId) {
      const linkedTx = await this.transactionsRepository.findOne({
        where: { id: split.linkedTransactionId },
      });

      if (linkedTx) {
        // Revert the balance change in the target account
        await this.accountsService.updateBalance(
          linkedTx.accountId,
          -Number(linkedTx.amount),
        );
        await this.transactionsRepository.remove(linkedTx);
      }
    }

    await this.splitsRepository.remove(split);

    // Check remaining splits
    const remainingSplits = await this.getSplits(userId, transactionId);
    if (remainingSplits.length < 2) {
      // Convert back to simple transaction if less than 2 splits
      if (remainingSplits.length === 1) {
        const lastSplit = remainingSplits[0];

        // If the last split is a transfer, also clean it up
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

        await this.transactionsRepository.update(transactionId, {
          isSplit: false,
          categoryId: lastSplit.categoryId, // Will be null if it was a transfer split
        });
        await this.splitsRepository.remove(lastSplit);
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
      toAmount: explicitToAmount,
      description,
      referenceNumber,
      status = TransactionStatus.UNRECONCILED,
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

    // Use explicit toAmount if provided (for cross-currency transfers), otherwise calculate from exchange rate
    const toAmount = explicitToAmount !== undefined
      ? Math.round(explicitToAmount * 10000) / 10000
      : Math.round(amount * exchangeRate * 10000) / 10000;
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
      status,
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
      status,
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

    this.triggerNetWorthRecalc(fromAccountId, userId);
    this.triggerNetWorthRecalc(toAccountId, userId);

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

    // Check if this transaction is a linked transaction from a split
    // If so, we need to clean up the parent split as well
    const parentSplit = await this.splitsRepository.findOne({
      where: { linkedTransactionId: transactionId },
    });

    if (parentSplit) {
      // This is a linked transaction from a split - delete the entire parent transaction
      const parentTransactionId = parentSplit.transactionId;
      const parentTransaction = await this.transactionsRepository.findOne({
        where: { id: parentTransactionId },
      });

      if (parentTransaction) {
        // Get all splits for the parent transaction
        const allSplits = await this.splitsRepository.find({
          where: { transactionId: parentTransactionId },
        });

        // Clean up all linked transactions from other transfer splits
        for (const split of allSplits) {
          if (split.linkedTransactionId && split.linkedTransactionId !== transactionId) {
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

        // Delete all splits
        await this.splitsRepository.remove(allSplits);

        // Revert the parent transaction balance and delete it
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          -Number(parentTransaction.amount),
        );
        await this.transactionsRepository.remove(parentTransaction);
      }

      // Revert the balance and remove this transaction (the linked one being deleted)
      await this.accountsService.updateBalance(
        transaction.accountId,
        -Number(transaction.amount),
      );
      this.triggerNetWorthRecalc(transaction.accountId, userId);
      await this.transactionsRepository.remove(transaction);
      return;
    }

    // Regular transfer deletion - get the linked transaction
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
      this.triggerNetWorthRecalc(linkedTransaction.accountId, userId);
      // Remove linked transaction first (to avoid FK issues if any)
      await this.transactionsRepository.remove(linkedTransaction);
    }

    this.triggerNetWorthRecalc(transaction.accountId, userId);

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

    const oldFromAccountId = fromTransaction.accountId;
    const oldToAccountId = toTransaction.accountId;
    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);

    // Validate new account IDs if provided
    const newFromAccountId = updateDto.fromAccountId ?? oldFromAccountId;
    const newToAccountId = updateDto.toAccountId ?? oldToAccountId;

    if (newFromAccountId === newToAccountId) {
      throw new BadRequestException('Source and destination accounts must be different');
    }

    // Verify new accounts belong to user if they changed
    let newFromAccount = fromTransaction.account;
    let newToAccount = toTransaction.account;

    if (updateDto.fromAccountId && updateDto.fromAccountId !== oldFromAccountId) {
      newFromAccount = await this.accountsService.findOne(userId, updateDto.fromAccountId);
    }
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      newToAccount = await this.accountsService.findOne(userId, updateDto.toAccountId);
    }

    // Update values
    const newAmount = updateDto.amount ?? oldFromAmount;
    const newExchangeRate = updateDto.exchangeRate ?? toTransaction.exchangeRate;
    // Use explicit toAmount if provided, otherwise calculate from exchange rate
    const newToAmount = updateDto.toAmount !== undefined
      ? Math.round(updateDto.toAmount * 10000) / 10000
      : Math.round(newAmount * newExchangeRate * 10000) / 10000;

    // Check if accounts or amounts changed - need to update balances
    const accountsOrAmountsChanged =
      updateDto.fromAccountId ||
      updateDto.toAccountId ||
      updateDto.amount !== undefined ||
      updateDto.exchangeRate !== undefined ||
      updateDto.toAmount !== undefined;

    // Revert old account balances first if anything changed
    if (accountsOrAmountsChanged) {
      await this.accountsService.updateBalance(oldFromAccountId, oldFromAmount);
      await this.accountsService.updateBalance(oldToAccountId, -oldToAmount);
    }

    // Update from transaction
    const fromUpdateData: Partial<Transaction> = {};
    if (updateDto.transactionDate) fromUpdateData.transactionDate = updateDto.transactionDate as any;
    if (updateDto.amount !== undefined) fromUpdateData.amount = -newAmount;
    if (updateDto.description !== undefined) fromUpdateData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined) fromUpdateData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) fromUpdateData.status = updateDto.status;
    if (updateDto.fromCurrencyCode) fromUpdateData.currencyCode = updateDto.fromCurrencyCode;

    // Handle account change for from transaction
    if (updateDto.fromAccountId && updateDto.fromAccountId !== oldFromAccountId) {
      fromUpdateData.accountId = updateDto.fromAccountId;
    }

    // Update payeeName if toAccount changed
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      fromUpdateData.payeeName = `Transfer to ${newToAccount.name}`;
      if (updateDto.description === undefined) {
        fromUpdateData.description = `Transfer to ${newToAccount.name}`;
      }
    }

    if (Object.keys(fromUpdateData).length > 0) {
      await this.transactionsRepository.update(fromTransaction.id, fromUpdateData);
    }

    // Update to transaction
    const toUpdateData: Partial<Transaction> = {};
    if (updateDto.transactionDate) toUpdateData.transactionDate = updateDto.transactionDate as any;
    if (updateDto.amount !== undefined || updateDto.exchangeRate !== undefined || updateDto.toAmount !== undefined) toUpdateData.amount = newToAmount;
    if (updateDto.description !== undefined) toUpdateData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined) toUpdateData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) toUpdateData.status = updateDto.status;
    if (updateDto.toCurrencyCode) toUpdateData.currencyCode = updateDto.toCurrencyCode;
    if (updateDto.exchangeRate) toUpdateData.exchangeRate = updateDto.exchangeRate;

    // Handle account change for to transaction
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      toUpdateData.accountId = updateDto.toAccountId;
    }

    // Update payeeName if fromAccount changed
    if (updateDto.fromAccountId && updateDto.fromAccountId !== oldFromAccountId) {
      toUpdateData.payeeName = `Transfer from ${newFromAccount.name}`;
      if (updateDto.description === undefined) {
        toUpdateData.description = `Transfer from ${newFromAccount.name}`;
      }
    }

    if (Object.keys(toUpdateData).length > 0) {
      await this.transactionsRepository.update(toTransaction.id, toUpdateData);
    }

    // Apply new balances to (potentially new) accounts
    if (accountsOrAmountsChanged) {
      await this.accountsService.updateBalance(newFromAccountId, -newAmount);
      await this.accountsService.updateBalance(newToAccountId, newToAmount);
    }

    // Trigger net worth recalc for all affected accounts
    const affectedAccounts = new Set([oldFromAccountId, oldToAccountId, newFromAccountId, newToAccountId]);
    for (const accId of affectedAccounts) {
      this.triggerNetWorthRecalc(accId, userId);
    }

    return {
      fromTransaction: await this.findOne(userId, fromTransaction.id),
      toTransaction: await this.findOne(userId, toTransaction.id),
    };
  }
}
