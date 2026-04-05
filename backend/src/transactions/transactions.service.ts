import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository, In, DataSource, QueryRunner } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { TagsService } from "../tags/tags.service";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TransactionSplitService } from "./transaction-split.service";
import {
  TransactionTransferService,
  TransferResult,
} from "./transaction-transfer.service";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import {
  TransactionBulkUpdateService,
  BulkUpdateResult,
  BulkDeleteResult,
} from "./transaction-bulk-update.service";
import { BulkUpdateDto, BulkDeleteDto } from "./dto/bulk-update.dto";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";

export interface TransactionWithInvestmentLink extends Transaction {
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
  startingBalance?: number;
}

export { TransferResult };

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
    private tagsService: TagsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private splitService: TransactionSplitService,
    private transferService: TransactionTransferService,
    private reconciliationService: TransactionReconciliationService,
    private analyticsService: TransactionAnalyticsService,
    private bulkUpdateService: TransactionBulkUpdateService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(
    userId: string,
    createTransactionDto: CreateTransactionDto,
  ): Promise<Transaction> {
    await this.accountsService.findOne(userId, createTransactionDto.accountId);

    const { splits, tagIds, ...transactionData } = createTransactionDto;
    const hasSplits = splits && splits.length > 0;

    if (hasSplits) {
      this.splitService.validateSplits(splits, createTransactionDto.amount);
    }

    // Validate ownership of referenced payee and category
    if (transactionData.payeeId) {
      await this.payeesService.findOne(userId, transactionData.payeeId);
    }
    if (transactionData.categoryId) {
      const cat = await this.categoriesRepository.findOne({
        where: { id: transactionData.categoryId, userId },
      });
      if (!cat) {
        throw new NotFoundException("Category not found");
      }
    }

    let categoryId = transactionData.categoryId;
    if (!hasSplits && !categoryId && transactionData.payeeId) {
      try {
        const payee = await this.payeesService.findOne(
          userId,
          transactionData.payeeId,
        );
        if (payee.defaultCategoryId) {
          categoryId = payee.defaultCategoryId;
        }
      } catch {
        // Payee already validated above; this is for default category lookup
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedTransactionId: string;

    try {
      const transaction = queryRunner.manager.create(Transaction, {
        ...transactionData,
        categoryId: hasSplits ? null : categoryId,
        isSplit: hasSplits,
        userId,
        exchangeRate: transactionData.exchangeRate || 1,
      });

      const savedTransaction = await queryRunner.manager.save(transaction);
      savedTransactionId = savedTransaction.id;

      if (hasSplits) {
        const savedSplits = await this.splitService.createSplits(
          savedTransaction.id,
          splits,
          userId,
          createTransactionDto.accountId,
          new Date(createTransactionDto.transactionDate),
          transactionData.payeeName,
          queryRunner,
        );

        // Set split-level tags
        if (savedSplits && splits) {
          for (let i = 0; i < splits.length; i++) {
            const splitTagIds = splits[i].tagIds;
            if (splitTagIds && splitTagIds.length > 0 && savedSplits[i]) {
              await this.tagsService.setSplitTags(
                savedSplits[i].id,
                splitTagIds,
                userId,
                queryRunner,
              );
            }
          }
        }
      }

      // Set transaction-level tags
      if (tagIds && tagIds.length > 0) {
        await this.tagsService.setTransactionTags(
          savedTransaction.id,
          tagIds,
          userId,
          queryRunner,
        );
      }

      if (savedTransaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(createTransactionDto.transactionDate)) {
          await this.accountsService.recalculateCurrentBalance(
            createTransactionDto.accountId,
            queryRunner,
          );
        } else {
          await this.accountsService.updateBalance(
            createTransactionDto.accountId,
            Number(createTransactionDto.amount),
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

    this.netWorthService.triggerDebouncedRecalc(
      createTransactionDto.accountId,
      userId,
    );

    const result = await this.findOne(userId, savedTransactionId);
    this.recordTransactionAction(userId, result, "create");
    return result;
  }

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
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
  ): Promise<PaginatedTransactions> {
    let safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));

    const queryBuilder = this.transactionsRepository
      .createQueryBuilder("transaction")
      .leftJoinAndSelect("transaction.account", "account")
      .leftJoinAndSelect("transaction.payee", "payee")
      .leftJoinAndSelect("transaction.category", "category")
      .leftJoinAndSelect("transaction.tags", "tags")
      .leftJoinAndSelect("transaction.splits", "splits")
      .leftJoinAndSelect("splits.category", "splitCategory")
      .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
      .leftJoinAndSelect("splits.tags", "splitTags")
      .leftJoinAndSelect("transaction.linkedTransaction", "linkedTransaction")
      .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
      .leftJoinAndSelect("linkedTransaction.splits", "linkedSplits")
      .leftJoinAndSelect("linkedSplits.category", "linkedSplitCategory")
      .leftJoinAndSelect(
        "linkedSplits.transferAccount",
        "linkedSplitTransferAccount",
      )
      .where("transaction.userId = :userId", { userId })
      .orderBy("transaction.transactionDate", "DESC")
      .addOrderBy("transaction.createdAt", "DESC")
      .addOrderBy("transaction.id", "DESC");

    if (!includeInvestmentBrokerage) {
      queryBuilder.andWhere(
        "(account.accountSubType IS NULL OR account.accountSubType != 'INVESTMENT_BROKERAGE')",
      );
    }

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds,
      });
    }

    if (startDate) {
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate,
      });
    }

    if (endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate,
      });
    }

    if (categoryIds && categoryIds.length > 0) {
      await this.applyCategoryFilters(queryBuilder, categoryIds, userId);
    }

    if (payeeIds && payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds,
      });
    }

    if (search && search.trim()) {
      const escaped = search
        .trim()
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      const searchPattern = `%${escaped}%`;
      queryBuilder.andWhere(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
        { search: searchPattern },
      );
    }

    if (amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom,
      });
    }

    if (amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", { amountTo });
    }

    if (tagIds && tagIds.length > 0) {
      queryBuilder.leftJoin("transaction.tags", "filterTags");
      queryBuilder.leftJoin("splits.tags", "filterSplitTags");
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where("filterTags.id IN (:...filterTagIds)", {
            filterTagIds: tagIds,
          }).orWhere("filterSplitTags.id IN (:...filterTagIds)", {
            filterTagIds: tagIds,
          });
        }),
      );
    }

    if (targetTransactionId) {
      safePage = await this.calculateTargetPage(
        userId,
        targetTransactionId,
        safeLimit,
        accountIds,
        startDate,
        endDate,
        payeeIds,
        search,
        includeInvestmentBrokerage,
        safePage,
      );
    }

    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(safeLimit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / safeLimit);

    let startingBalance: number | undefined;
    const singleAccountId =
      accountIds?.length === 1 ? accountIds[0] : undefined;
    const hasContentFilters = !!(
      (categoryIds && categoryIds.length > 0) ||
      (payeeIds && payeeIds.length > 0) ||
      (tagIds && tagIds.length > 0) ||
      search ||
      amountFrom !== undefined ||
      amountTo !== undefined
    );
    if (singleAccountId && data.length > 0) {
      startingBalance = await this.calculateStartingBalance(
        userId,
        singleAccountId,
        safePage,
        skip,
        {
          startDate,
          endDate,
          categoryIds,
          payeeIds,
          tagIds,
          search,
          amountFrom,
          amountTo,
        },
      );
    } else if (
      accountIds &&
      accountIds.length > 1 &&
      hasContentFilters &&
      data.length > 0
    ) {
      startingBalance = await this.calculateMultiAccountContentFilteredBalance(
        userId,
        accountIds,
        safePage,
        skip,
        {
          startDate,
          endDate,
          categoryIds,
          payeeIds,
          tagIds,
          search,
          amountFrom,
          amountTo,
        },
      );
    } else if (
      (!accountIds || accountIds.length === 0) &&
      hasContentFilters &&
      data.length > 0
    ) {
      startingBalance = await this.calculateMultiAccountContentFilteredBalance(
        userId,
        undefined,
        safePage,
        skip,
        {
          startDate,
          endDate,
          categoryIds,
          payeeIds,
          tagIds,
          search,
          amountFrom,
          amountTo,
        },
      );
    }

    const enrichedData = await this.enrichWithInvestmentLinks(data);

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

  private async applyCategoryFilters(
    queryBuilder: any,
    categoryIds: string[],
    userId: string,
  ): Promise<void> {
    const hasUncategorized = categoryIds.includes("uncategorized");
    const hasTransfer = categoryIds.includes("transfer");
    const regularCategoryIds = categoryIds.filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );

    let hasCondition = false;

    if (hasUncategorized || hasTransfer || regularCategoryIds.length > 0) {
      const uniqueCategoryIds =
        regularCategoryIds.length > 0
          ? await getAllCategoryIdsWithChildren(
              this.categoriesRepository,
              userId,
              regularCategoryIds,
            )
          : [];

      queryBuilder.andWhere(
        new Brackets((qb) => {
          if (hasUncategorized) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND account.accountType != 'INVESTMENT'",
            );
          }
          if (hasTransfer) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method]("transaction.isTransfer = true");
          }
          if (uniqueCategoryIds.length > 0) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            // Filter on the main "splits" alias so that only matching split
            // rows are hydrated.  Non-matching splits are excluded from the
            // response, which lets the frontend detect partial amounts and
            // display a filtered total.  The edit form fetches the full
            // transaction via getById, so it still sees all splits.
            qb[method](
              new Brackets((inner) => {
                inner
                  .where("transaction.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  })
                  .orWhere("splits.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  });
              }),
            );
          }
        }),
      );
    }
  }

  private async calculateTargetPage(
    userId: string,
    targetTransactionId: string,
    safeLimit: number,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    payeeIds?: string[],
    search?: string,
    includeInvestmentBrokerage?: boolean,
    fallbackPage: number = 1,
  ): Promise<number> {
    try {
      const targetTx = await this.transactionsRepository.findOne({
        where: { id: targetTransactionId, userId },
        select: ["id", "transactionDate", "createdAt"],
      });

      if (!targetTx) return fallbackPage;

      const countQuery = this.transactionsRepository
        .createQueryBuilder("t")
        .leftJoin("t.account", "a")
        .leftJoin("t.splits", "s")
        .where("t.userId = :userId", { userId });

      if (!includeInvestmentBrokerage) {
        countQuery.andWhere(
          "(a.accountSubType IS NULL OR a.accountSubType != 'INVESTMENT_BROKERAGE')",
        );
      }
      if (accountIds && accountIds.length > 0) {
        countQuery.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }
      if (startDate) {
        countQuery.andWhere("t.transactionDate >= :startDate", { startDate });
      }
      if (endDate) {
        countQuery.andWhere("t.transactionDate <= :endDate", { endDate });
      }
      if (payeeIds && payeeIds.length > 0) {
        countQuery.andWhere("t.payeeId IN (:...payeeIds)", { payeeIds });
      }
      if (search && search.trim()) {
        const escaped = search
          .trim()
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_");
        const searchPattern = `%${escaped}%`;
        countQuery.andWhere(
          "(t.description ILIKE :search OR t.payeeName ILIKE :search OR s.memo ILIKE :search)",
          { search: searchPattern },
        );
      }

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
      return Math.floor(countBefore / safeLimit) + 1;
    } catch (error) {
      this.logger.error(
        "Failed to find target transaction page:",
        error instanceof Error ? error.stack : String(error),
      );
      return fallbackPage;
    }
  }

  private async calculateStartingBalance(
    userId: string,
    singleAccountId: string,
    safePage: number,
    skip: number,
    filters?: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const hasContentFilters = !!(
      (filters?.categoryIds && filters.categoryIds.length > 0) ||
      (filters?.payeeIds && filters.payeeIds.length > 0) ||
      (filters?.tagIds && filters.tagIds.length > 0) ||
      filters?.search ||
      filters?.amountFrom !== undefined ||
      filters?.amountTo !== undefined
    );
    const hasDateFilter = !!(filters?.startDate || filters?.endDate);

    if (hasContentFilters) {
      return this.calculateContentFilteredBalance(
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    if (hasDateFilter) {
      return this.calculateDateFilteredBalance(
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    // No filters: original behavior
    return this.calculateUnfilteredBalance(
      userId,
      singleAccountId,
      safePage,
      skip,
    );
  }

  /**
   * Original unfiltered balance calculation. Returns projected balance
   * (current + future) adjusted for pagination.
   */
  private async calculateUnfilteredBalance(
    userId: string,
    singleAccountId: string,
    safePage: number,
    skip: number,
  ): Promise<number> {
    const projectedBalance = await this.computeProjectedBalance(
      userId,
      singleAccountId,
    );

    if (safePage === 1) {
      return projectedBalance;
    }

    const previousPagesQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :singleAccountId", { singleAccountId })
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

    const sumResult = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("SUM(transaction.amount)", "sum")
      .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
      .setParameters(previousPagesQuery.getParameters())
      .getRawOne();

    const sumBefore = Number(sumResult?.sum) || 0;
    return projectedBalance - sumBefore;
  }

  /**
   * Content-filtered balance: zero-based running balance.
   * startingBalance = totalSum of all matching transactions (page 1)
   * or totalSum - sumOfPreviousPages (page > 1).
   */
  private async calculateContentFilteredBalance(
    userId: string,
    accountId: string,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      userId,
      accountId,
      filters,
    );

    const totalSum = await this.computeSplitAwareSum(
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(userId, accountId, skip, filters))
    );
  }

  /**
   * Multi-account content-filtered balance: zero-based running balance
   * across multiple accounts when content filters are active.
   */
  private async calculateMultiAccountContentFilteredBalance(
    userId: string,
    accountIds: string[] | undefined,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      userId,
      accountIds,
      filters,
    );

    const totalSum = await this.computeSplitAwareSum(
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(
        userId,
        accountIds,
        skip,
        filters,
      ))
    );
  }

  /**
   * Date-filtered balance: shows actual account balance at the date range.
   * With endDate: balance at end of date range.
   * With only startDate: projected balance (same as unfiltered).
   * Adjusted for pagination within the filtered set.
   */
  private async calculateDateFilteredBalance(
    userId: string,
    accountId: string,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
    },
  ): Promise<number> {
    let baseBalance: number;

    if (filters.endDate) {
      // Balance at end of date range = projected - sum(tx after endDate)
      const projectedBalance = await this.computeProjectedBalance(
        userId,
        accountId,
      );

      const sumAfterResult = await this.transactionsRepository
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "sum")
        .where("t.userId = :userId", { userId })
        .andWhere("t.accountId = :accountId", { accountId })
        .andWhere("t.transactionDate > :endDate", {
          endDate: filters.endDate,
        })
        .getRawOne();

      baseBalance = projectedBalance - (Number(sumAfterResult?.sum) || 0);
    } else {
      // Only startDate: top of list is still projected balance
      baseBalance = await this.computeProjectedBalance(userId, accountId);
    }

    if (safePage === 1) return baseBalance;

    // For page > 1, subtract sum of previous pages (within filtered set)
    const previousPagesQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId })
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

    if (filters.startDate) {
      previousPagesQuery.andWhere("t.transactionDate >= :startDate", {
        startDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      previousPagesQuery.andWhere("t.transactionDate <= :endDate", {
        endDate: filters.endDate,
      });
    }

    const sumResult = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("SUM(transaction.amount)", "sum")
      .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
      .setParameters(previousPagesQuery.getParameters())
      .getRawOne();

    return baseBalance - (Number(sumResult?.sum) || 0);
  }

  /**
   * Compute projected balance (current balance + future non-void transactions).
   */
  private async computeProjectedBalance(
    userId: string,
    accountId: string,
  ): Promise<number> {
    const account = await this.accountsService.findOne(userId, accountId);
    const currentBalance = Number(account.currentBalance) || 0;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const futureResult = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "sum")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId })
      .andWhere("t.transactionDate > :today", { today })
      .andWhere("t.status != :void", { void: TransactionStatus.VOID })
      .getRawOne();

    return currentBalance + (Number(futureResult?.sum) || 0);
  }

  /**
   * Sum of filtered transactions on previous pages (for content-filtered pagination).
   */
  private async computeFilteredPrevPagesSum(
    userId: string,
    accountId: string | string[] | undefined,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      userId,
      accountId,
      filters,
    );

    // Get ordered matching transactions, limited to previous pages
    const prevIdsQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where(`t.id IN (${idsSubquery.getQuery()})`)
      .setParameters(idsSubquery.getParameters())
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

    return this.computeSplitAwareSum(prevIdsQuery, userId, filters);
  }

  /**
   * Compute a split-aware sum for a set of transaction IDs.
   *
   * When category or tag filters are active, splits are joined with the
   * same filter conditions used by findAll().  Non-matching split rows
   * are excluded, so COALESCE(splits.amount, t.amount) produces the
   * partial split sum for partially-matching split transactions and the
   * full t.amount for non-split transactions.
   */
  private async computeSplitAwareSum(
    idsSubquery: {
      getQuery: () => string;
      getParameters: () => Record<string, any>;
    },
    userId: string,
    filters: {
      categoryIds?: string[];
      tagIds?: string[];
    },
  ): Promise<number> {
    const regularCategoryIds = (filters.categoryIds ?? []).filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );
    const hasRegularCategories = regularCategoryIds.length > 0;
    const hasTags = (filters.tagIds?.length ?? 0) > 0;

    if (!hasRegularCategories && !hasTags) {
      const result = await this.transactionsRepository
        .createQueryBuilder("sa")
        .select("COALESCE(SUM(sa.amount), 0)", "totalSum")
        .where(`sa.id IN (${idsSubquery.getQuery()})`)
        .setParameters(idsSubquery.getParameters())
        .getRawOne();
      return Number(result?.totalSum) || 0;
    }

    const sumQb = this.transactionsRepository
      .createQueryBuilder("sa")
      .where(`sa.id IN (${idsSubquery.getQuery()})`)
      .setParameters(idsSubquery.getParameters());

    sumQb.leftJoin("sa.splits", "saSplits");

    if (hasRegularCategories) {
      const expandedIds = await getAllCategoryIdsWithChildren(
        this.categoriesRepository,
        userId,
        regularCategoryIds,
      );
      if (expandedIds.length > 0) {
        sumQb.andWhere(
          new Brackets((qb) => {
            qb.where("sa.categoryId IN (:...saCatIds)", {
              saCatIds: expandedIds,
            }).orWhere("saSplits.categoryId IN (:...saCatIds)");
          }),
        );
      }
    }

    if (hasTags) {
      sumQb.leftJoin("sa.tags", "saTags");
      sumQb.leftJoin("saSplits.tags", "saSplitTags");
      sumQb.andWhere(
        new Brackets((qb) => {
          qb.where("saTags.id IN (:...saTagIds)", {
            saTagIds: filters.tagIds,
          }).orWhere("saSplitTags.id IN (:...saTagIds)");
        }),
      );
    }

    sumQb.select(
      "COALESCE(SUM(COALESCE(saSplits.amount, sa.amount)), 0)",
      "totalSum",
    );
    const result = await sumQb.getRawOne();
    return Number(result?.totalSum) || 0;
  }

  /**
   * Build a subquery that returns DISTINCT transaction IDs matching
   * the given content/date filters for a single account.
   */
  private async buildFilteredIdsSubquery(
    userId: string,
    accountId: string | string[] | undefined,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ) {
    const qb = this.transactionsRepository
      .createQueryBuilder("bf")
      .select("DISTINCT bf.id")
      .where("bf.userId = :bfUserId", { bfUserId: userId });

    if (Array.isArray(accountId)) {
      qb.andWhere("bf.accountId IN (:...bfAccountIds)", {
        bfAccountIds: accountId,
      });
    } else if (accountId) {
      qb.andWhere("bf.accountId = :bfAccountId", { bfAccountId: accountId });
    }

    if (filters.startDate) {
      qb.andWhere("bf.transactionDate >= :bfStartDate", {
        bfStartDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      qb.andWhere("bf.transactionDate <= :bfEndDate", {
        bfEndDate: filters.endDate,
      });
    }
    if (filters.payeeIds && filters.payeeIds.length > 0) {
      qb.andWhere("bf.payeeId IN (:...bfPayeeIds)", {
        bfPayeeIds: filters.payeeIds,
      });
    }
    if (filters.amountFrom !== undefined) {
      qb.andWhere("bf.amount >= :bfAmountFrom", {
        bfAmountFrom: filters.amountFrom,
      });
    }
    if (filters.amountTo !== undefined) {
      qb.andWhere("bf.amount <= :bfAmountTo", {
        bfAmountTo: filters.amountTo,
      });
    }

    // Determine if we need a splits join (shared across search/category/tag)
    const needsSplitsJoin = !!(
      filters.search ||
      (filters.categoryIds &&
        filters.categoryIds.some(
          (id) => id !== "uncategorized" && id !== "transfer",
        )) ||
      (filters.tagIds && filters.tagIds.length > 0)
    );

    if (needsSplitsJoin) {
      qb.leftJoin("bf.splits", "bfSplits");
    }

    if (filters.search) {
      const escaped = filters.search
        .trim()
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      qb.andWhere(
        "(bf.description ILIKE :bfSearch OR bf.payeeName ILIKE :bfSearch OR bfSplits.memo ILIKE :bfSearch)",
        { bfSearch: `%${escaped}%` },
      );
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      const hasUncategorized = filters.categoryIds.includes("uncategorized");
      const hasTransfer = filters.categoryIds.includes("transfer");
      const regularIds = filters.categoryIds.filter(
        (id) => id !== "uncategorized" && id !== "transfer",
      );

      const expandedIds =
        regularIds.length > 0
          ? await getAllCategoryIdsWithChildren(
              this.categoriesRepository,
              userId,
              regularIds,
            )
          : [];

      qb.andWhere(
        new Brackets((outer) => {
          let hasCondition = false;
          if (hasUncategorized) {
            outer.where(
              "bf.categoryId IS NULL AND bf.isSplit = false AND bf.isTransfer = false",
            );
            hasCondition = true;
          }
          if (hasTransfer) {
            const method = hasCondition ? "orWhere" : "where";
            outer[method]("bf.isTransfer = true");
            hasCondition = true;
          }
          if (expandedIds.length > 0) {
            const method = hasCondition ? "orWhere" : "where";
            outer[method](
              new Brackets((inner) => {
                inner
                  .where("bf.categoryId IN (:...bfCatIds)", {
                    bfCatIds: expandedIds,
                  })
                  .orWhere("bfSplits.categoryId IN (:...bfCatIds)");
              }),
            );
          }
        }),
      );
    }

    if (filters.tagIds && filters.tagIds.length > 0) {
      qb.leftJoin("bf.tags", "bfTags");
      qb.leftJoin("bfSplits.tags", "bfSplitTags");
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where("bfTags.id IN (:...bfTagIds)", {
              bfTagIds: filters.tagIds,
            })
            .orWhere("bfSplitTags.id IN (:...bfTagIds)");
        }),
      );
    }

    return qb;
  }

  private async enrichWithInvestmentLinks(
    data: Transaction[],
  ): Promise<TransactionWithInvestmentLink[]> {
    const transactionIds = data.map((tx) => tx.id);
    const investmentLinkMap = new Map<string, string>();

    if (transactionIds.length > 0) {
      const linkedInvestmentTxs =
        await this.investmentTransactionsRepository.find({
          where: { transactionId: In(transactionIds) },
          select: ["id", "transactionId"],
        });

      for (const invTx of linkedInvestmentTxs) {
        if (invTx.transactionId) {
          investmentLinkMap.set(invTx.transactionId, invTx.id);
        }
      }
    }

    return data.map((tx) => ({
      ...tx,
      isCleared: tx.isCleared,
      isReconciled: tx.isReconciled,
      isVoid: tx.isVoid,
      linkedInvestmentTransactionId: investmentLinkMap.get(tx.id) || null,
    }));
  }

  async findOne(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.transactionsRepository.findOne({
      where: { id, userId },
      relations: [
        "account",
        "payee",
        "category",
        "tags",
        "splits",
        "splits.category",
        "splits.transferAccount",
        "splits.tags",
        "linkedTransaction",
        "linkedTransaction.account",
      ],
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }

    return transaction;
  }

  async update(
    userId: string,
    id: string,
    updateTransactionDto: UpdateTransactionDto,
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    const beforeSnapshot = this.snapshotTransaction(transaction);
    const oldAmount = Number(transaction.amount);
    const oldAccountId = transaction.accountId;
    const oldTransactionDate = transaction.transactionDate;
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;

    const { splits, tagIds, createdAt, ...updateData } = updateTransactionDto;

    if (updateData.accountId && updateData.accountId !== oldAccountId) {
      await this.accountsService.findOne(userId, updateData.accountId);
    }

    // Validate ownership of referenced payee and category
    if (updateData.payeeId) {
      await this.payeesService.findOne(userId, updateData.payeeId);
    }
    if ("categoryId" in updateData && updateData.categoryId) {
      const cat = await this.categoriesRepository.findOne({
        where: { id: updateData.categoryId, userId },
      });
      if (!cat) {
        throw new NotFoundException("Category not found");
      }
    }

    // Validate splits before starting the transaction
    if (splits !== undefined && Array.isArray(splits) && splits.length > 0) {
      const amount = updateData.amount ?? transaction.amount;
      this.splitService.validateSplits(splits, amount);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (splits !== undefined) {
        if (Array.isArray(splits) && splits.length > 0) {
          await this.splitService.deleteTransferSplitLinkedTransactions(
            id,
            queryRunner,
          );
          await queryRunner.manager.delete(TransactionSplit, {
            transactionId: id,
          });

          const accountId = updateData.accountId ?? transaction.accountId;
          const txDate =
            updateData.transactionDate ?? transaction.transactionDate;
          const savedSplits = await this.splitService.createSplits(
            id,
            splits,
            userId,
            accountId,
            new Date(txDate),
            updateData.payeeName ?? transaction.payeeName,
            queryRunner,
          );

          // Set split-level tags
          if (savedSplits) {
            for (let i = 0; i < splits.length; i++) {
              const splitTagIds = splits[i].tagIds;
              if (splitTagIds && splitTagIds.length > 0 && savedSplits[i]) {
                await this.tagsService.setSplitTags(
                  savedSplits[i].id,
                  splitTagIds,
                  userId,
                  queryRunner,
                );
              }
            }
          }
        } else if (Array.isArray(splits) && splits.length === 0) {
          await this.splitService.deleteTransferSplitLinkedTransactions(
            id,
            queryRunner,
          );
          await queryRunner.manager.delete(TransactionSplit, {
            transactionId: id,
          });
          await queryRunner.manager.update(Transaction, id, {
            isSplit: false,
          });
        }
      }

      const transactionUpdateData: Partial<Transaction> = {};

      if ("accountId" in updateData)
        transactionUpdateData.accountId = updateData.accountId;
      if ("transactionDate" in updateData)
        transactionUpdateData.transactionDate =
          updateData.transactionDate as any;
      if ("payeeId" in updateData)
        transactionUpdateData.payeeId = updateData.payeeId ?? null;
      if ("payeeName" in updateData)
        transactionUpdateData.payeeName = updateData.payeeName ?? null;
      if ("categoryId" in updateData)
        transactionUpdateData.categoryId = updateData.categoryId ?? null;
      if ("amount" in updateData)
        transactionUpdateData.amount = updateData.amount;
      if ("currencyCode" in updateData)
        transactionUpdateData.currencyCode = updateData.currencyCode;
      if ("exchangeRate" in updateData)
        transactionUpdateData.exchangeRate = updateData.exchangeRate;
      if ("description" in updateData)
        transactionUpdateData.description = updateData.description ?? null;
      if ("referenceNumber" in updateData)
        transactionUpdateData.referenceNumber =
          updateData.referenceNumber ?? null;
      if ("status" in updateData)
        transactionUpdateData.status = updateData.status;
      if ("reconciledDate" in updateData)
        transactionUpdateData.reconciledDate = updateData.reconciledDate as any;
      if (createdAt !== undefined)
        transactionUpdateData.createdAt = createdAt as any;

      if (splits && splits.length > 0) {
        transactionUpdateData.categoryId = null;
        transactionUpdateData.isSplit = true;
      }

      if (Object.keys(transactionUpdateData).length > 0) {
        await queryRunner.manager.update(
          Transaction,
          id,
          transactionUpdateData,
        );
      }

      // Update transaction-level tags
      if (tagIds !== undefined) {
        await this.tagsService.setTransactionTags(
          id,
          tagIds,
          userId,
          queryRunner,
        );
      }

      const savedTransaction = await queryRunner.manager.findOne(Transaction, {
        where: { id, userId },
      });
      if (!savedTransaction) {
        throw new NotFoundException(`Transaction with ID ${id} not found`);
      }

      const newAmount = Number(savedTransaction.amount);
      const newAccountId = savedTransaction.accountId;
      const newStatus = savedTransaction.status;
      const isVoid = newStatus === TransactionStatus.VOID;
      const oldIsFuture = isTransactionInFuture(oldTransactionDate);
      const newIsFuture = isTransactionInFuture(
        savedTransaction.transactionDate,
      );
      const anyFuture = oldIsFuture || newIsFuture;

      if (anyFuture) {
        const affectedAccounts = new Set([oldAccountId, newAccountId]);
        for (const accId of affectedAccounts) {
          await this.accountsService.recalculateCurrentBalance(
            accId,
            queryRunner,
          );
        }
      } else if (wasVoid && !isVoid) {
        await this.accountsService.updateBalance(
          newAccountId,
          newAmount,
          queryRunner,
        );
      } else if (!wasVoid && isVoid) {
        await this.accountsService.updateBalance(
          oldAccountId,
          -oldAmount,
          queryRunner,
        );
      } else if (!wasVoid && !isVoid) {
        if (newAccountId !== oldAccountId) {
          await this.accountsService.updateBalance(
            oldAccountId,
            -oldAmount,
            queryRunner,
          );
          await this.accountsService.updateBalance(
            newAccountId,
            newAmount,
            queryRunner,
          );
        } else if (newAmount !== oldAmount) {
          const balanceChange = newAmount - oldAmount;
          await this.accountsService.updateBalance(
            newAccountId,
            balanceChange,
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

    const finalTransaction = await this.findOne(userId, id);

    this.netWorthService.triggerDebouncedRecalc(
      finalTransaction.accountId,
      userId,
    );
    if (oldAccountId !== finalTransaction.accountId) {
      this.netWorthService.triggerDebouncedRecalc(oldAccountId, userId);
    }

    this.actionHistoryService.record(userId, {
      entityType: "transaction",
      entityId: id,
      action: "update",
      beforeData: beforeSnapshot,
      afterData: this.snapshotTransaction(finalTransaction),
      description: `Updated transaction ${finalTransaction.payeeName || ""} $${Number(finalTransaction.amount).toFixed(2)}`,
    });
    return finalTransaction;
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);
    const beforeSnapshot = this.snapshotTransaction(transaction);
    const accountId = transaction.accountId;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (transaction.isSplit) {
        await this.splitService.deleteTransferSplitLinkedTransactions(
          id,
          queryRunner,
        );
      }

      const parentSplit = await queryRunner.manager.findOne(TransactionSplit, {
        where: { linkedTransactionId: id },
      });

      if (parentSplit) {
        await this.removeParentTransaction(
          parentSplit,
          id,
          queryRunner,
          userId,
        );
      }

      if (transaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(transaction.transactionDate)) {
          await queryRunner.manager.remove(transaction);
          await this.accountsService.recalculateCurrentBalance(
            accountId,
            queryRunner,
          );
          await queryRunner.commitTransaction();
          this.netWorthService.triggerDebouncedRecalc(accountId, userId);
          this.recordTransactionAction(userId, { ...transaction, ...beforeSnapshot } as Transaction, "delete", beforeSnapshot);
          return;
        } else {
          await this.accountsService.updateBalance(
            accountId,
            -Number(transaction.amount),
            queryRunner,
          );
        }
      }

      await queryRunner.manager.remove(transaction);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    this.recordTransactionAction(userId, { ...transaction, ...beforeSnapshot } as Transaction, "delete", beforeSnapshot);
  }

  private async removeParentTransaction(
    parentSplit: TransactionSplit,
    linkedTransactionId: string,
    queryRunner: QueryRunner,
    userId: string,
  ): Promise<void> {
    const parentTransactionId = parentSplit.transactionId;
    const parentTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: parentTransactionId, userId },
    });

    if (parentTransaction) {
      const allSplits = await queryRunner.manager.find(TransactionSplit, {
        where: { transactionId: parentTransactionId },
      });

      for (const split of allSplits) {
        if (
          split.linkedTransactionId &&
          split.linkedTransactionId !== linkedTransactionId
        ) {
          const linkedTx = await queryRunner.manager.findOne(Transaction, {
            where: { id: split.linkedTransactionId, userId },
          });

          if (linkedTx) {
            const linkedAccId = linkedTx.accountId;
            const linkedIsFuture = isTransactionInFuture(
              linkedTx.transactionDate,
            );
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

      if (parentTransaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(parentTransaction.transactionDate)) {
          await queryRunner.manager.remove(parentTransaction);
          await this.accountsService.recalculateCurrentBalance(
            parentTransaction.accountId,
            queryRunner,
          );
          return;
        }
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          -Number(parentTransaction.amount),
          queryRunner,
        );
      }
      await queryRunner.manager.remove(parentTransaction);
    }
  }

  // Delegated methods

  async updateStatus(
    userId: string,
    id: string,
    status: TransactionStatus,
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.updateStatus(
      transaction,
      status,
      userId,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async markCleared(
    userId: string,
    id: string,
    isCleared: boolean,
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.markCleared(
      transaction,
      isCleared,
      userId,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async reconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.reconcile(
      transaction,
      userId,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async unreconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.unreconcile(
      transaction,
      userId,
      this.findOne.bind(this),
    );
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ) {
    return this.reconciliationService.getReconciliationData(
      userId,
      accountId,
      statementDate,
      statementBalance,
    );
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ) {
    return this.reconciliationService.bulkReconcile(
      userId,
      accountId,
      transactionIds,
      reconciledDate,
    );
  }

  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
  ) {
    return this.analyticsService.getSummary(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
    );
  }

  async getMonthlyTotals(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
  ) {
    return this.analyticsService.getMonthlyTotals(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
      tagIds,
    );
  }

  async getSplits(userId: string, transactionId: string) {
    await this.findOne(userId, transactionId);
    return this.splitService.getSplits(transactionId);
  }

  async updateSplits(
    userId: string,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
  ) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.updateSplits(transaction, splits, userId);
  }

  async addSplit(
    userId: string,
    transactionId: string,
    splitDto: CreateTransactionSplitDto,
  ) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.addSplit(transaction, splitDto, userId);
  }

  async removeSplit(userId: string, transactionId: string, splitId: string) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.removeSplit(transaction, splitId, userId);
  }

  async createTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
  ): Promise<TransferResult> {
    const result = await this.transferService.createTransfer(
      userId,
      createTransferDto,
      this.findOne.bind(this),
    );

    if (createTransferDto.tagIds && createTransferDto.tagIds.length > 0) {
      await this.tagsService.setTransactionTags(
        result.fromTransaction.id,
        createTransferDto.tagIds,
        userId,
      );
      await this.tagsService.setTransactionTags(
        result.toTransaction.id,
        createTransferDto.tagIds,
        userId,
      );

      return {
        fromTransaction: await this.findOne(userId, result.fromTransaction.id),
        toTransaction: await this.findOne(userId, result.toTransaction.id),
      };
    }

    return result;
  }

  async getLinkedTransaction(
    userId: string,
    transactionId: string,
  ): Promise<Transaction | null> {
    return this.transferService.getLinkedTransaction(
      userId,
      transactionId,
      this.findOne.bind(this),
    );
  }

  async removeTransfer(userId: string, transactionId: string): Promise<void> {
    return this.transferService.removeTransfer(
      userId,
      transactionId,
      this.findOne.bind(this),
    );
  }

  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<CreateTransferDto>,
  ): Promise<TransferResult> {
    const result = await this.transferService.updateTransfer(
      userId,
      transactionId,
      updateDto,
      this.findOne.bind(this),
    );

    if (updateDto.tagIds !== undefined) {
      await this.tagsService.setTransactionTags(
        result.fromTransaction.id,
        updateDto.tagIds,
        userId,
      );
      await this.tagsService.setTransactionTags(
        result.toTransaction.id,
        updateDto.tagIds,
        userId,
      );

      return {
        fromTransaction: await this.findOne(userId, result.fromTransaction.id),
        toTransaction: await this.findOne(userId, result.toTransaction.id),
      };
    }

    return result;
  }

  async bulkUpdate(
    userId: string,
    bulkUpdateDto: BulkUpdateDto,
  ): Promise<BulkUpdateResult> {
    return this.bulkUpdateService.bulkUpdate(userId, bulkUpdateDto);
  }

  async bulkDelete(
    userId: string,
    bulkDeleteDto: BulkDeleteDto,
  ): Promise<BulkDeleteResult> {
    return this.bulkUpdateService.bulkDelete(userId, bulkDeleteDto);
  }

  private snapshotTransaction(
    tx: Transaction,
  ): Record<string, any> {
    return {
      id: tx.id,
      accountId: tx.accountId,
      transactionDate: tx.transactionDate,
      amount: tx.amount,
      currencyCode: tx.currencyCode,
      exchangeRate: tx.exchangeRate,
      payeeId: tx.payeeId,
      payeeName: tx.payeeName,
      categoryId: tx.categoryId,
      description: tx.description,
      referenceNumber: tx.referenceNumber,
      status: tx.status,
      isSplit: tx.isSplit,
      isTransfer: tx.isTransfer,
      linkedTransactionId: tx.linkedTransactionId,
      parentTransactionId: tx.parentTransactionId,
      reconciledDate: tx.reconciledDate,
      createdAt: tx.createdAt,
      splits: tx.splits?.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        transferAccountId: s.transferAccountId,
        linkedTransactionId: s.linkedTransactionId,
        amount: s.amount,
        memo: s.memo,
      })),
      tagIds: tx.tags?.map((t) => t.id),
    };
  }

  private recordTransactionAction(
    userId: string,
    tx: Transaction,
    action: "create" | "update" | "delete",
    beforeData?: Record<string, any>,
  ): void {
    const snapshot = action === "delete" ? beforeData : this.snapshotTransaction(tx);
    this.actionHistoryService.record(userId, {
      entityType: "transaction",
      entityId: tx.id,
      action,
      beforeData: action === "create" ? undefined : beforeData,
      afterData: action === "delete" ? undefined : snapshot,
      description: `${action === "create" ? "Created" : action === "update" ? "Updated" : "Deleted"} transaction ${tx.payeeName || ""} $${Number(tx.amount).toFixed(2)}`,
    });
  }
}
