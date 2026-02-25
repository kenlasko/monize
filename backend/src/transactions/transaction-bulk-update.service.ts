import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, SelectQueryBuilder } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { BulkUpdateDto, BulkUpdateFilterDto } from "./dto/bulk-update.dto";

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
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
  ) {}

  async bulkUpdate(
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<BulkUpdateResult> {
    const updateFields = this.extractUpdateFields(dto);
    if (Object.keys(updateFields).length === 0) {
      throw new BadRequestException(
        "At least one update field must be provided",
      );
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

    // Step 3: Handle balance adjustments for VOID status changes
    if (isUpdatingStatus) {
      await this.handleStatusBalanceChanges(userId, eligibleIds, dto.status!);
    }

    // Step 4: Execute batch update
    await this.transactionsRepository
      .createQueryBuilder()
      .update(Transaction)
      .set(updateFields)
      .where("id IN (:...ids)", { ids: eligibleIds })
      .andWhere("userId = :userId", { userId })
      .execute();

    // Step 5: Trigger net worth recalc for affected accounts
    if (isUpdatingStatus) {
      await this.triggerNetWorthRecalcForTransactions(userId, eligibleIds);
    }

    return {
      updated: eligibleIds.length,
      skipped,
      skippedReasons,
    };
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
    isUpdatingPayee: boolean,
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
    let transferCount = 0;
    let splitCount = 0;

    const eligibleIds = transactions
      .filter((t) => {
        if ((isUpdatingPayee || isUpdatingCategory) && t.isTransfer) {
          transferCount++;
          return false;
        }
        if (isUpdatingCategory && t.isSplit) {
          splitCount++;
          return false;
        }
        return true;
      })
      .map((t) => t.id);

    if (transferCount > 0) {
      skippedReasons.push(`${transferCount} transfer`);
    }
    if (splitCount > 0) {
      skippedReasons.push(`${splitCount} split`);
    }

    return {
      eligibleIds,
      skipped: transferCount + splitCount,
      skippedReasons,
    };
  }

  private async handleStatusBalanceChanges(
    userId: string,
    eligibleIds: string[],
    newStatus: TransactionStatus,
  ): Promise<void> {
    const isNewVoid = newStatus === TransactionStatus.VOID;

    // Query transactions that will actually change to/from VOID
    const statusCondition = isNewVoid
      ? "transaction.status != :voidStatus"
      : "transaction.status = :voidStatus";

    // Only include non-future transactions in balance changes
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const balanceDeltas = await this.transactionsRepository
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
        await this.accountsService.updateBalance(row.accountId, -amount);
      } else {
        // Leaving VOID: add amounts to balances
        await this.accountsService.updateBalance(row.accountId, amount);
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
      this.netWorthService
        .recalculateAccount(userId, row.accountId)
        .catch((err) =>
          this.logger.warn(
            `Net worth recalc failed for account ${row.accountId}: ${err.message}`,
          ),
        );
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
      const searchPattern = `%${filters.search.trim()}%`;
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

    const conditions: string[] = [];

    if (hasUncategorized) {
      queryBuilder.leftJoin("transaction.account", "filterAccount");
      conditions.push(
        "(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND filterAccount.accountType != 'INVESTMENT')",
      );
    }

    if (hasTransfer) {
      conditions.push("transaction.isTransfer = true");
    }

    if (regularCategoryIds.length > 0) {
      const uniqueCategoryIds = await this.getAllCategoryIdsWithChildren(
        userId,
        regularCategoryIds,
      );

      if (uniqueCategoryIds.length > 0) {
        queryBuilder.leftJoin("transaction.splits", "filterSplits");
        conditions.push(
          "(transaction.categoryId IN (:...filterCategoryIds) OR filterSplits.categoryId IN (:...filterCategoryIds))",
        );
        queryBuilder.setParameter("filterCategoryIds", uniqueCategoryIds);
      }
    }

    if (conditions.length > 0) {
      queryBuilder.andWhere(`(${conditions.join(" OR ")})`);
    }
  }

  private async getAllCategoryIdsWithChildren(
    userId: string,
    categoryIds: string[],
  ): Promise<string[]> {
    const categories = await this.categoriesRepository.find({
      where: { userId },
      select: ["id", "parentId"],
    });

    const result = new Set<string>();
    const addWithChildren = (parentId: string) => {
      result.add(parentId);
      for (const cat of categories) {
        if (cat.parentId === parentId && !result.has(cat.id)) {
          addWithChildren(cat.id);
        }
      }
    };

    for (const catId of categoryIds) {
      addWithChildren(catId);
    }

    return [...result];
  }
}
