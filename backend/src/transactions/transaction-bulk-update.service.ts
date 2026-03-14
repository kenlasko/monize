import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository, SelectQueryBuilder, DataSource } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TagsService } from "../tags/tags.service";
import {
  BulkUpdateDto,
  BulkDeleteDto,
  BulkUpdateFilterDto,
} from "./dto/bulk-update.dto";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { isTransactionInFuture } from "../common/date-utils";

export interface BulkDeleteResult {
  deleted: number;
}

export interface BulkUpdateResult {
  updated: number;
  skipped: number;
  skippedReasons: string[];
}

@Injectable()
export class TransactionBulkUpdateService {
  private readonly logger = new Logger(TransactionBulkUpdateService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private tagsService: TagsService,
    private dataSource: DataSource,
  ) {}

  async bulkUpdate(
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<BulkUpdateResult> {
    const updateFields = this.extractUpdateFields(dto);
    const isUpdatingTags = "tagIds" in dto;
    if (Object.keys(updateFields).length === 0 && !isUpdatingTags) {
      throw new BadRequestException(
        "At least one update field must be provided",
      );
    }

    // H4: Validate ownership of categoryId and payeeId before applying
    if ("categoryId" in dto && dto.categoryId) {
      const cat = await this.categoriesRepository.findOne({
        where: { id: dto.categoryId, userId },
      });
      if (!cat) {
        throw new NotFoundException("Category not found");
      }
    }
    if ("payeeId" in dto && dto.payeeId) {
      const payee = await this.payeesRepository.findOne({
        where: { id: dto.payeeId, userId },
      });
      if (!payee) {
        throw new NotFoundException("Payee not found");
      }
    }

    const isUpdatingPayee = "payeeId" in dto || "payeeName" in dto;
    const isUpdatingCategory = "categoryId" in dto;
    const isUpdatingStatus = "status" in dto;

    // Step 1: Get eligible transaction IDs
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      return { updated: 0, skipped: 0, skippedReasons: [] };
    }

    // Step 2: Apply exclusions and compute skip counts
    const { eligibleIds, skipped, skippedReasons } = await this.applyExclusions(
      userId,
      allIds,
      isUpdatingPayee,
      isUpdatingCategory,
    );

    if (eligibleIds.length === 0) {
      return { updated: 0, skipped, skippedReasons };
    }

    // Wrap balance changes and batch update in a single transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Step 3: Handle balance adjustments for VOID status changes
      if (isUpdatingStatus) {
        await this.handleStatusBalanceChanges(
          userId,
          eligibleIds,
          dto.status!,
          queryRunner,
        );
      }

      // Step 4: Execute batch update for column fields
      if (Object.keys(updateFields).length > 0) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Transaction)
          .set(updateFields)
          .where("id IN (:...ids)", { ids: eligibleIds })
          .andWhere("userId = :userId", { userId })
          .execute();

        // Step 4b: Sync payee/description to linked transfer transactions
        await this.syncLinkedTransfers(
          userId,
          eligibleIds,
          updateFields,
          queryRunner,
        );
      }

      // Step 4c: Update tags (many-to-many relation, must be done per-transaction)
      if (isUpdatingTags) {
        for (const txId of eligibleIds) {
          await this.tagsService.setTransactionTags(
            txId,
            dto.tagIds ?? [],
            userId,
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

    // Step 5: Trigger net worth recalc for affected accounts (after commit)
    if (isUpdatingStatus) {
      await this.triggerNetWorthRecalcForTransactions(userId, eligibleIds);
    }

    return {
      updated: eligibleIds.length,
      skipped,
      skippedReasons,
    };
  }

  async bulkDelete(
    userId: string,
    dto: BulkDeleteDto,
  ): Promise<BulkDeleteResult> {
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      return { deleted: 0 };
    }

    // Load transaction details needed for balance adjustments and linked transfers
    const transactions = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select([
        "transaction.id",
        "transaction.accountId",
        "transaction.amount",
        "transaction.status",
        "transaction.transactionDate",
        "transaction.isTransfer",
        "transaction.linkedTransactionId",
        "transaction.isSplit",
      ])
      .leftJoinAndSelect("transaction.splits", "splits")
      .where("transaction.id IN (:...ids)", { ids: allIds })
      .andWhere("transaction.userId = :userId", { userId })
      .getMany();

    if (transactions.length === 0) {
      return { deleted: 0 };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Collect linked transaction IDs from transfers and split transfers
      const linkedIdsToDelete = new Set<string>();
      const transactionIdsSet = new Set(transactions.map((t) => t.id));

      for (const tx of transactions) {
        if (
          tx.linkedTransactionId &&
          !transactionIdsSet.has(tx.linkedTransactionId)
        ) {
          linkedIdsToDelete.add(tx.linkedTransactionId);
        }
        if (tx.isSplit && tx.splits) {
          for (const split of tx.splits) {
            if (
              split.linkedTransactionId &&
              !transactionIdsSet.has(split.linkedTransactionId)
            ) {
              linkedIdsToDelete.add(split.linkedTransactionId);
            }
          }
        }
      }

      // Load linked transactions for balance adjustments
      let linkedTransactions: Transaction[] = [];
      if (linkedIdsToDelete.size > 0) {
        linkedTransactions = await queryRunner.manager
          .createQueryBuilder(Transaction, "transaction")
          .select([
            "transaction.id",
            "transaction.accountId",
            "transaction.amount",
            "transaction.status",
            "transaction.transactionDate",
          ])
          .where("transaction.id IN (:...ids)", {
            ids: [...linkedIdsToDelete],
          })
          .andWhere("transaction.userId = :userId", { userId })
          .getMany();
      }

      // Adjust balances for all transactions being deleted (primary + linked)
      const allTransactionsToDelete = [...transactions, ...linkedTransactions];
      const balanceAdjustments = new Map<string, number>();

      for (const tx of allTransactionsToDelete) {
        if (
          tx.status !== TransactionStatus.VOID &&
          !isTransactionInFuture(tx.transactionDate)
        ) {
          const current = balanceAdjustments.get(tx.accountId) || 0;
          balanceAdjustments.set(tx.accountId, current - Number(tx.amount));
        }
      }

      for (const [accountId, adjustment] of balanceAdjustments) {
        if (adjustment !== 0) {
          await this.accountsService.updateBalance(
            accountId,
            adjustment,
            queryRunner,
          );
        }
      }

      // Delete linked transactions first (foreign key order)
      if (linkedIdsToDelete.size > 0) {
        await queryRunner.manager
          .createQueryBuilder()
          .delete()
          .from(Transaction)
          .where("id IN (:...ids)", { ids: [...linkedIdsToDelete] })
          .andWhere("userId = :userId", { userId })
          .execute();
      }

      // Delete the primary transactions
      await queryRunner.manager
        .createQueryBuilder()
        .delete()
        .from(Transaction)
        .where("id IN (:...ids)", { ids: allIds })
        .andWhere("userId = :userId", { userId })
        .execute();

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Trigger net worth recalc for all affected accounts
    const affectedAccountIds = new Set(transactions.map((t) => t.accountId));
    for (const accountId of affectedAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }

    return { deleted: transactions.length };
  }

  private extractUpdateFields(dto: BulkUpdateDto): Partial<Transaction> {
    const fields: Record<string, unknown> = {};

    if ("payeeId" in dto) {
      fields.payeeId = dto.payeeId ?? null;
    }
    if ("payeeName" in dto) {
      fields.payeeName = dto.payeeName ?? null;
    }
    if ("categoryId" in dto) {
      fields.categoryId = dto.categoryId ?? null;
    }
    if ("description" in dto) {
      fields.description = dto.description ?? null;
    }
    if ("status" in dto) {
      fields.status = dto.status;
    }

    return fields as Partial<Transaction>;
  }

  private async resolveTransactionIds(
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<string[]> {
    if (dto.mode === "ids") {
      if (!dto.transactionIds || dto.transactionIds.length === 0) {
        return [];
      }

      const transactions = await this.transactionsRepository
        .createQueryBuilder("transaction")
        .select("transaction.id")
        .where("transaction.id IN (:...ids)", { ids: dto.transactionIds })
        .andWhere("transaction.userId = :userId", { userId })
        .getMany();

      return transactions.map((t) => t.id);
    }

    // Filter mode
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("transaction.id")
      .where("transaction.userId = :userId", { userId });

    await this.applyFilters(queryBuilder, userId, dto.filters || {});

    const transactions = await queryBuilder.getMany();
    return transactions.map((t) => t.id);
  }

  private async applyExclusions(
    userId: string,
    allIds: string[],
    _isUpdatingPayee: boolean,
    isUpdatingCategory: boolean,
  ): Promise<{
    eligibleIds: string[];
    skipped: number;
    skippedReasons: string[];
  }> {
    // Fetch transaction details needed for exclusion logic
    const transactions = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select([
        "transaction.id",
        "transaction.isTransfer",
        "transaction.isSplit",
      ])
      .where("transaction.id IN (:...ids)", { ids: allIds })
      .andWhere("transaction.userId = :userId", { userId })
      .getMany();

    const skippedReasons: string[] = [];
    let splitCount = 0;

    const eligibleIds = transactions
      .filter((t) => {
        if (isUpdatingCategory && t.isSplit) {
          splitCount++;
          return false;
        }
        return true;
      })
      .map((t) => t.id);

    if (splitCount > 0) {
      const plural = splitCount !== 1 ? "s" : "";
      skippedReasons.push(
        `${splitCount} split transaction${plural} skipped (split categories must be updated individually)`,
      );
    }

    return {
      eligibleIds,
      skipped: splitCount,
      skippedReasons,
    };
  }

  /**
   * For transfer transactions in the batch, apply payee and description
   * updates to their linked counterparts so both sides stay in sync.
   * Category is NOT synced because each side of a transfer may use
   * different categories (e.g. "Transfer In" vs "Transfer Out").
   */
  private async syncLinkedTransfers(
    userId: string,
    eligibleIds: string[],
    updateFields: Partial<Transaction>,
    queryRunner: import("typeorm").QueryRunner,
  ): Promise<void> {
    // Build the subset of fields that should sync to the linked side
    const syncFields: Record<string, unknown> = {};
    if ("payeeId" in updateFields) syncFields.payeeId = updateFields.payeeId;
    if ("payeeName" in updateFields)
      syncFields.payeeName = updateFields.payeeName;
    if ("description" in updateFields)
      syncFields.description = updateFields.description;

    if (Object.keys(syncFields).length === 0) return;

    // Find linked transaction IDs for transfers in the batch
    const repo = queryRunner.manager.getRepository(Transaction);
    const transfers = await repo
      .createQueryBuilder("t")
      .select(["t.linkedTransactionId"])
      .where("t.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("t.userId = :userId", { userId })
      .andWhere("t.isTransfer = true")
      .andWhere("t.linkedTransactionId IS NOT NULL")
      .getMany();

    const linkedIds = transfers
      .map((t) => t.linkedTransactionId)
      .filter((id): id is string => id !== null);

    if (linkedIds.length === 0) return;

    await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set(syncFields as Partial<Transaction>)
      .where("id IN (:...ids)", { ids: linkedIds })
      .andWhere("userId = :userId", { userId })
      .execute();
  }

  private async handleStatusBalanceChanges(
    userId: string,
    eligibleIds: string[],
    newStatus: TransactionStatus,
    queryRunner?: import("typeorm").QueryRunner,
  ): Promise<void> {
    const isNewVoid = newStatus === TransactionStatus.VOID;

    // Query transactions that will actually change to/from VOID
    const statusCondition = isNewVoid
      ? "transaction.status != :voidStatus"
      : "transaction.status = :voidStatus";

    // Only include non-future transactions in balance changes
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const repo = queryRunner
      ? queryRunner.manager.getRepository(Transaction)
      : this.transactionsRepository;

    const balanceDeltas = await repo
      .createQueryBuilder("transaction")
      .select("transaction.accountId", "accountId")
      .addSelect("SUM(transaction.amount)", "totalAmount")
      .where("transaction.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("transaction.userId = :userId", { userId })
      .andWhere(statusCondition, { voidStatus: TransactionStatus.VOID })
      .andWhere("transaction.transactionDate <= :today", { today })
      .groupBy("transaction.accountId")
      .getRawMany();

    for (const row of balanceDeltas) {
      const amount = Number(row.totalAmount) || 0;
      if (amount === 0) continue;

      if (isNewVoid) {
        // Becoming VOID: subtract amounts from balances
        await this.accountsService.updateBalance(
          row.accountId,
          -amount,
          queryRunner,
        );
      } else {
        // Leaving VOID: add amounts to balances
        await this.accountsService.updateBalance(
          row.accountId,
          amount,
          queryRunner,
        );
      }
    }
  }

  private async triggerNetWorthRecalcForTransactions(
    userId: string,
    transactionIds: string[],
  ): Promise<void> {
    const accountIds = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("DISTINCT transaction.accountId", "accountId")
      .where("transaction.id IN (:...ids)", { ids: transactionIds })
      .getRawMany();

    for (const row of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(row.accountId, userId);
    }
  }

  private async applyFilters(
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    filters: BulkUpdateFilterDto,
  ): Promise<void> {
    if (filters.accountIds && filters.accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds: filters.accountIds,
      });
    }

    if (filters.startDate) {
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate: filters.startDate,
      });
    }

    if (filters.endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate: filters.endDate,
      });
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      await this.applyCategoryFilters(
        queryBuilder,
        userId,
        filters.categoryIds,
      );
    }

    if (filters.payeeIds && filters.payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds: filters.payeeIds,
      });
    }

    if (filters.search && filters.search.trim()) {
      const escaped = filters.search
        .trim()
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      const searchPattern = `%${escaped}%`;
      if (!filters.categoryIds || filters.categoryIds.length === 0) {
        queryBuilder.leftJoin("transaction.splits", "searchSplits");
        queryBuilder.andWhere(
          "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR searchSplits.memo ILIKE :search)",
          { search: searchPattern },
        );
      } else {
        queryBuilder.andWhere(
          "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR filterSplits.memo ILIKE :search)",
          { search: searchPattern },
        );
      }
    }
  }

  private async applyCategoryFilters(
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    categoryIds: string[],
  ): Promise<void> {
    const hasUncategorized = categoryIds.includes("uncategorized");
    const hasTransfer = categoryIds.includes("transfer");
    const regularCategoryIds = categoryIds.filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );

    let hasCondition = false;

    if (hasUncategorized || hasTransfer || regularCategoryIds.length > 0) {
      if (hasUncategorized) {
        queryBuilder.leftJoin("transaction.account", "filterAccount");
      }

      const uniqueCategoryIds =
        regularCategoryIds.length > 0
          ? await getAllCategoryIdsWithChildren(
              this.categoriesRepository,
              userId,
              regularCategoryIds,
            )
          : [];

      if (uniqueCategoryIds.length > 0) {
        queryBuilder.leftJoin("transaction.splits", "filterSplits");
      }

      queryBuilder.andWhere(
        new Brackets((qb) => {
          if (hasUncategorized) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND filterAccount.accountType != 'INVESTMENT'",
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
            qb[method](
              new Brackets((inner) => {
                inner
                  .where("transaction.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  })
                  .orWhere(
                    "filterSplits.categoryId IN (:...filterCategoryIds)",
                    { filterCategoryIds: uniqueCategoryIds },
                  );
              }),
            );
          }
        }),
      );
    }
  }
}
