import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, Like, In, Not, IsNull } from "typeorm";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { UpdatePayeeDto } from "./dto/update-payee.dto";
import { CreatePayeeAliasDto } from "./dto/create-payee-alias.dto";
import { MergePayeeDto } from "./dto/merge-payee.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { toCountMap } from "../common/count-map.util";
import { matchesAliasPattern } from "./alias-match.util";
import {
  applyPayeeCategoryToAll,
  backfillPayeeCategory,
  countUncategorizedTransactionsByPayee,
} from "./payee-backfill.util";

function escapeLikeWildcards(value: string): string {
  // Escape backslash first, then the LIKE wildcards. Escaping only the
  // wildcards would leave backslashes unescaped, letting an attacker submit
  // '\%' and neutralise the escaping (CWE-20).
  return value.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

@Injectable()
export class PayeesService {
  private readonly logger = new Logger(PayeesService.name);

  constructor(
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    @InjectRepository(PayeeAlias)
    private aliasRepository: Repository<PayeeAlias>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(userId: string, createPayeeDto: CreatePayeeDto): Promise<Payee> {
    // Check if payee with same name already exists for this user
    const existing = await this.payeesRepository.findOne({
      where: {
        userId,
        name: createPayeeDto.name,
      },
    });

    if (existing) {
      throw new ConflictException(
        tr(
          "errors.payees.nameConflict",
          `Payee with name "${createPayeeDto.name}" already exists`,
          { name: createPayeeDto.name },
        ),
      );
    }

    const payee = this.payeesRepository.create({
      ...createPayeeDto,
      userId,
    });

    const saved = await this.payeesRepository.save(payee);
    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        notes: saved.notes,
        defaultCategoryId: saved.defaultCategoryId,
        isActive: saved.isActive,
      },
      description: `Created payee "${saved.name}"`,
      descriptionKey: "createdPayee",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  async findAll(
    userId: string,
    status?: "active" | "inactive" | "all",
  ): Promise<
    (Payee & {
      transactionCount: number;
      lastUsedDate: string | null;
      aliasCount: number;
      uncategorizedCount: number;
    })[]
  > {
    // Build where clause based on status filter
    const where: any = { userId };
    if (status === "active") {
      where.isActive = true;
    } else if (status === "inactive") {
      where.isActive = false;
    }
    // "all" or undefined = no isActive filter

    // Get all payees with their default category
    const payees = await this.payeesRepository.find({
      where,
      relations: ["defaultCategory"],
      order: { name: "ASC" },
    });

    if (payees.length === 0) {
      return [];
    }

    // Get transaction counts and last used dates for all payees in one query
    const stats = await this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoin(
        "transactions",
        "transaction",
        "transaction.payee_id = payee.id AND transaction.user_id = :userId",
        { userId },
      )
      .where("payee.user_id = :userId", { userId })
      .groupBy("payee.id")
      .select([
        "payee.id as id",
        "COUNT(transaction.id) as count",
        "MAX(transaction.transaction_date) as last_used_date",
      ])
      .getRawMany();

    // Get alias counts for all payees in one query
    const aliasCounts = await this.aliasRepository
      .createQueryBuilder("alias")
      .where("alias.user_id = :userId", { userId })
      .groupBy("alias.payee_id")
      .select(["alias.payee_id as payee_id", "COUNT(alias.id) as alias_count"])
      .getRawMany();

    // Create maps for counts and last used dates
    const countMap = toCountMap(stats);
    const lastUsedMap = new Map<string, string | null>();
    for (const row of stats) {
      lastUsedMap.set(row.id, row.last_used_date || null);
    }

    const aliasCountMap = toCountMap(aliasCounts, {
      keyField: "payee_id",
      countField: "alias_count",
    });

    // Per-payee count of transactions with no category (excluding transfers and
    // split parents) -- the same scope the default-category backfill targets --
    // so the list can flag payees that still have uncategorized transactions.
    const uncategorizedCountMap = await countUncategorizedTransactionsByPayee(
      this.payeesRepository.manager,
      userId,
    );

    // Merge stats with payees
    return payees.map((payee) => ({
      ...payee,
      transactionCount: countMap.get(payee.id) || 0,
      lastUsedDate: lastUsedMap.get(payee.id) || null,
      aliasCount: aliasCountMap.get(payee.id) || 0,
      uncategorizedCount: uncategorizedCountMap.get(payee.id) || 0,
    }));
  }

  async findOne(userId: string, id: string): Promise<Payee> {
    const payee = await this.payeesRepository.findOne({
      where: { id, userId },
      relations: ["defaultCategory"],
    });

    if (!payee) {
      throw new NotFoundException(
        tr("errors.payees.notFound", `Payee with ID ${id} not found`, { id }),
      );
    }

    return payee;
  }

  async search(
    userId: string,
    query: string,
    limit: number = 10,
  ): Promise<Payee[]> {
    return this.payeesRepository.find({
      where: {
        userId,
        isActive: true,
        name: Like(`%${escapeLikeWildcards(query)}%`),
      },
      relations: ["defaultCategory"],
      order: { name: "ASC" },
      take: limit,
    });
  }

  async autocomplete(userId: string, query: string): Promise<Payee[]> {
    // Return active payees that start with the query (for autocomplete)
    return this.payeesRepository.find({
      where: {
        userId,
        isActive: true,
        name: Like(`${escapeLikeWildcards(query)}%`),
      },
      relations: ["defaultCategory"],
      order: { name: "ASC" },
      take: 10,
    });
  }

  async findByName(userId: string, name: string): Promise<Payee | null> {
    return this.payeesRepository.findOne({
      where: { userId, name },
      relations: ["defaultCategory"],
    });
  }

  /**
   * Find an inactive payee by name (case-insensitive).
   * Used to check if a typed payee name matches a deactivated payee.
   */
  async findInactiveByName(
    userId: string,
    name: string,
  ): Promise<Payee | null> {
    return this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
      .where("payee.user_id = :userId", { userId })
      .andWhere("payee.is_active = false")
      .andWhere("LOWER(payee.name) = LOWER(:name)", { name })
      .getOne();
  }

  async findOrCreate(
    userId: string,
    name: string,
    defaultCategoryId?: string,
  ): Promise<Payee> {
    // Try to find existing payee by name
    let payee = await this.findByName(userId, name);

    if (!payee) {
      // Create new payee if it doesn't exist
      payee = await this.create(userId, {
        name,
        defaultCategoryId,
      });
    }

    return payee;
  }

  async update(
    userId: string,
    id: string,
    updatePayeeDto: UpdatePayeeDto,
  ): Promise<
    Payee & {
      aliasCount: number;
      transactionCount: number;
      transactionsCategorized: number;
    }
  > {
    const payee = await this.findOne(userId, id);
    const beforeData = {
      name: payee.name,
      notes: payee.notes,
      defaultCategoryId: payee.defaultCategoryId,
      isActive: payee.isActive,
    };

    // Check for name conflicts if name is being updated
    if (updatePayeeDto.name && updatePayeeDto.name !== payee.name) {
      const existing = await this.payeesRepository.findOne({
        where: {
          userId,
          name: updatePayeeDto.name,
        },
      });

      if (existing) {
        throw new ConflictException(
          tr(
            "errors.payees.nameConflict",
            `Payee with name "${updatePayeeDto.name}" already exists`,
            { name: updatePayeeDto.name },
          ),
        );
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    const nameChanged =
      updatePayeeDto.name !== undefined && updatePayeeDto.name !== payee.name;
    if (updatePayeeDto.name !== undefined) payee.name = updatePayeeDto.name;
    if (updatePayeeDto.defaultCategoryId !== undefined) {
      payee.defaultCategoryId = updatePayeeDto.defaultCategoryId;
      // Always clear the loaded relation object. Otherwise TypeORM's save()
      // re-derives the FK from the stale relation entity and ignores the
      // changed scalar -- so switching to a different category (or to null)
      // would silently not persist.
      payee.defaultCategory = null as any;
    }
    if (updatePayeeDto.notes !== undefined) payee.notes = updatePayeeDto.notes;
    if (updatePayeeDto.isActive !== undefined)
      payee.isActive = updatePayeeDto.isActive;

    // Optionally apply the (new) default category to the payee's existing
    // transactions. Only meaningful when the payee ends up with a category.
    const applyMode = updatePayeeDto.applyCategoryToTransactions ?? "none";

    // Save the payee and cascade the name change to existing transactions and
    // scheduled transactions atomically, so a partial failure cannot leave the
    // denormalised payeeName snapshots out of sync with the payee record. The
    // optional category backfill runs in the same transaction so the payee
    // default and its transactions can never drift apart on a partial failure.
    let transactionsCategorized = 0;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.manager.save(payee);

      if (nameChanged) {
        await queryRunner.manager.update(
          Transaction,
          { payeeId: id, userId },
          { payeeName: updatePayeeDto.name },
        );
        await queryRunner.manager.update(
          ScheduledTransaction,
          { payeeId: id, userId },
          { payeeName: updatePayeeDto.name },
        );
      }

      if (applyMode !== "none" && payee.defaultCategoryId) {
        transactionsCategorized =
          applyMode === "all"
            ? await applyPayeeCategoryToAll(
                queryRunner.manager,
                userId,
                id,
                payee.defaultCategoryId,
              )
            : await backfillPayeeCategory(
                queryRunner.manager,
                userId,
                id,
                payee.defaultCategoryId,
              );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Re-fetch with relations and computed counts so the frontend has complete data
    const refreshed = await this.findOne(userId, id);
    const aliasCount = await this.aliasRepository.count({
      where: { payeeId: id },
    });
    const transactionCount = await this.transactionsRepository.count({
      where: { payeeId: id, userId },
    });
    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: id,
      action: "update",
      beforeData,
      afterData: {
        name: refreshed.name,
        notes: refreshed.notes,
        defaultCategoryId: refreshed.defaultCategoryId,
        isActive: refreshed.isActive,
      },
      description: `Updated payee "${refreshed.name}"`,
      descriptionKey: "updatedPayee",
      descriptionParams: { name: refreshed.name },
    });
    return {
      ...refreshed,
      aliasCount,
      transactionCount,
      transactionsCategorized,
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const payee = await this.findOne(userId, id);
    const beforeData = {
      id: payee.id,
      name: payee.name,
      notes: payee.notes,
      defaultCategoryId: payee.defaultCategoryId,
      isActive: payee.isActive,
    };
    await this.payeesRepository.remove(payee);
    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted payee "${beforeData.name}"`,
      descriptionKey: "deletedPayee",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getMostUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Single query: join defaultCategory + aggregate transaction count, avoiding two-step fetch
    // Only return active payees for dropdown use
    return this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
      .leftJoin(
        "transactions",
        "transaction",
        "transaction.payee_id = payee.id AND transaction.user_id = :userId",
        { userId },
      )
      .where("payee.user_id = :userId", { userId })
      .andWhere("payee.is_active = true")
      .groupBy("payee.id")
      .addGroupBy("defaultCategory.id")
      .orderBy("COUNT(transaction.id)", "DESC")
      .limit(limit)
      .getMany();
  }

  async getRecentlyUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Single query: join defaultCategory + aggregate most recent date, avoiding two-step fetch
    // Only return active payees for dropdown use
    return this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
      .leftJoin(
        "transactions",
        "transaction",
        "transaction.payee_id = payee.id AND transaction.user_id = :userId",
        { userId },
      )
      .where("payee.user_id = :userId", { userId })
      .andWhere("payee.is_active = true")
      .groupBy("payee.id")
      .addGroupBy("defaultCategory.id")
      .orderBy("MAX(transaction.transaction_date)", "DESC")
      .limit(limit)
      .getMany();
  }

  async getSummary(userId: string) {
    const totalPayees = await this.payeesRepository.count({
      where: { userId },
    });

    const payeesWithCategory = await this.payeesRepository.count({
      where: {
        userId,
        defaultCategoryId: Not(IsNull()),
      },
    });

    const activePayees = await this.payeesRepository.count({
      where: { userId, isActive: true },
    });

    const inactivePayees = totalPayees - activePayees;

    return {
      totalPayees,
      payeesWithCategory,
      payeesWithoutCategory: totalPayees - payeesWithCategory,
      activePayees,
      inactivePayees,
    };
  }

  async findByCategory(userId: string, categoryId: string): Promise<Payee[]> {
    return this.payeesRepository.find({
      where: {
        userId,
        defaultCategoryId: categoryId,
      },
      relations: ["defaultCategory"],
      order: { name: "ASC" },
    });
  }

  /**
   * Preview which payees would be deactivated based on the given criteria.
   * Returns payees with fewer than maxTransactions and last used before the cutoff date.
   */
  async previewDeactivation(
    userId: string,
    maxTransactions: number,
    monthsUnused: number,
  ): Promise<
    Array<{
      payeeId: string;
      payeeName: string;
      transactionCount: number;
      lastUsedDate: string | null;
      defaultCategoryName: string | null;
    }>
  > {
    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsUnused);
    const cutoffDateStr = cutoffDate.toISOString().split("T")[0];

    // Get active payees with their transaction counts and last used dates
    const results = await this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
      .leftJoin(
        "transactions",
        "t",
        "t.payee_id = payee.id AND t.user_id = :userId",
        { userId },
      )
      .where("payee.user_id = :userId", { userId })
      .andWhere("payee.is_active = true")
      .groupBy("payee.id")
      .addGroupBy("defaultCategory.id")
      .having("COUNT(t.id) <= :maxTransactions", { maxTransactions })
      .andHaving(
        "(MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < :cutoffDate)",
        { cutoffDate: cutoffDateStr },
      )
      .select([
        "payee.id as payee_id",
        "payee.name as payee_name",
        "COUNT(t.id) as transaction_count",
        "MAX(t.transaction_date) as last_used_date",
        "defaultCategory.name as default_category_name",
      ])
      .orderBy("payee.name", "ASC")
      .getRawMany();

    return results.map((row) => ({
      payeeId: row.payee_id,
      payeeName: row.payee_name,
      transactionCount: parseInt(row.transaction_count || "0", 10),
      lastUsedDate: row.last_used_date || null,
      defaultCategoryName: row.default_category_name || null,
    }));
  }

  /**
   * Bulk deactivate payees by IDs.
   */
  async deactivatePayees(
    userId: string,
    payeeIds: string[],
  ): Promise<{ deactivated: number }> {
    if (payeeIds.length === 0) {
      return { deactivated: 0 };
    }

    const uniqueIds = [...new Set(payeeIds)];
    const payees = await this.payeesRepository.find({
      where: { id: In(uniqueIds), userId, isActive: true },
    });

    const toSave: Payee[] = [];
    for (const payee of payees) {
      payee.isActive = false;
      toSave.push(payee);
    }

    if (toSave.length > 0) {
      await this.payeesRepository.save(toSave);
    }

    return { deactivated: toSave.length };
  }

  /**
   * Reactivate a single payee by ID.
   */
  async reactivatePayee(userId: string, id: string): Promise<Payee> {
    const payee = await this.findOne(userId, id);
    if (payee.isActive) {
      return payee;
    }
    payee.isActive = true;
    return this.payeesRepository.save(payee);
  }

  /**
   * Calculate suggested category assignments for payees based on transaction history.
   * @param userId The user ID
   * @param minTransactions Minimum number of transactions a payee must have
   * @param minPercentage Minimum percentage (0-100) a category must appear to be suggested
   * @param onlyWithoutCategory If true, only consider payees without a default category
   */
  async calculateCategorySuggestions(
    userId: string,
    minTransactions: number,
    minPercentage: number,
    onlyWithoutCategory: boolean = true,
  ): Promise<
    Array<{
      payeeId: string;
      payeeName: string;
      currentCategoryId: string | null;
      currentCategoryName: string | null;
      suggestedCategoryId: string;
      suggestedCategoryName: string;
      transactionCount: number;
      categoryCount: number;
      percentage: number;
      uncategorizedCount: number;
    }>
  > {
    // Get category usage statistics per payee
    // This query counts how many times each category is used for each payee
    const query = this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoin(
        "transactions",
        "t",
        "t.payee_id = payee.id AND t.is_transfer = false",
      )
      .leftJoin("categories", "c", "c.id = t.category_id")
      .where("payee.user_id = :userId", { userId })
      .andWhere("t.category_id IS NOT NULL")
      .groupBy("payee.id")
      .addGroupBy("payee.name")
      .addGroupBy("payee.default_category_id")
      .addGroupBy("t.category_id")
      .addGroupBy("c.name")
      .select([
        "payee.id as payee_id",
        "payee.name as payee_name",
        "payee.default_category_id as current_category_id",
        "t.category_id as category_id",
        "c.name as category_name",
        "COUNT(t.id) as category_count",
      ])
      .having("COUNT(t.id) > 0");

    if (onlyWithoutCategory) {
      query.andWhere("payee.default_category_id IS NULL");
    }

    const categoryUsage = await query.getRawMany();

    // Get total transaction count per payee
    const totalCountsQuery = this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoin(
        "transactions",
        "t",
        "t.payee_id = payee.id AND t.is_transfer = false",
      )
      .where("payee.user_id = :userId", { userId })
      .andWhere("t.category_id IS NOT NULL")
      .groupBy("payee.id")
      .select(["payee.id as payee_id", "COUNT(t.id) as total_count"])
      .having("COUNT(t.id) >= :minTransactions", { minTransactions });

    if (onlyWithoutCategory) {
      totalCountsQuery.andWhere("payee.default_category_id IS NULL");
    }

    const totalCounts = await totalCountsQuery.getRawMany();
    const totalCountMap = toCountMap(totalCounts, {
      keyField: "payee_id",
      countField: "total_count",
    });

    // Per-payee count of transactions a default-category backfill would touch,
    // surfaced per suggestion so the UI can offer the optional backfill.
    const uncategorizedCountMap = await countUncategorizedTransactionsByPayee(
      this.payeesRepository.manager,
      userId,
    );

    // Get current category names for payees that have one
    const payeesWithCategories = await this.payeesRepository.find({
      where: { userId },
      relations: ["defaultCategory"],
    });
    const currentCategoryMap = new Map<
      string,
      { id: string | null; name: string | null }
    >();
    for (const payee of payeesWithCategories) {
      currentCategoryMap.set(payee.id, {
        id: payee.defaultCategoryId,
        name: payee.defaultCategory?.name || null,
      });
    }

    // Find the most used category for each payee that meets the threshold
    const suggestions: Array<{
      payeeId: string;
      payeeName: string;
      currentCategoryId: string | null;
      currentCategoryName: string | null;
      suggestedCategoryId: string;
      suggestedCategoryName: string;
      transactionCount: number;
      categoryCount: number;
      percentage: number;
      uncategorizedCount: number;
    }> = [];

    // Group category usage by payee
    const payeeCategories = new Map<
      string,
      Array<{
        payeeName: string;
        categoryId: string;
        categoryName: string;
        count: number;
      }>
    >();

    for (const row of categoryUsage) {
      const payeeId = row.payee_id;
      if (!payeeCategories.has(payeeId)) {
        payeeCategories.set(payeeId, []);
      }
      payeeCategories.get(payeeId)!.push({
        payeeName: row.payee_name,
        categoryId: row.category_id,
        categoryName: row.category_name,
        count: parseInt(row.category_count, 10),
      });
    }

    // For each payee that meets minimum transaction threshold, find best category
    for (const [payeeId, categories] of payeeCategories) {
      const totalCount = totalCountMap.get(payeeId);
      if (!totalCount || totalCount < minTransactions) continue;

      // Sort categories by count (descending) and find the top one
      categories.sort((a, b) => b.count - a.count);
      const topCategory = categories[0];
      const percentage = (topCategory.count / totalCount) * 100;

      // Check if meets percentage threshold
      if (percentage >= minPercentage) {
        const current = currentCategoryMap.get(payeeId);
        // Skip if already has this category assigned
        if (current?.id === topCategory.categoryId) continue;

        suggestions.push({
          payeeId,
          payeeName: topCategory.payeeName,
          currentCategoryId: current?.id || null,
          currentCategoryName: current?.name || null,
          suggestedCategoryId: topCategory.categoryId,
          suggestedCategoryName: topCategory.categoryName,
          transactionCount: totalCount,
          categoryCount: topCategory.count,
          percentage: Math.round(percentage * 10) / 10,
          uncategorizedCount: uncategorizedCountMap.get(payeeId) ?? 0,
        });
      }
    }

    // Sort by payee name
    suggestions.sort((a, b) => a.payeeName.localeCompare(b.payeeName));

    return suggestions;
  }

  /**
   * Apply category suggestions to payees (bulk update). When an assignment opts
   * into `backfillTransactions`, that payee's existing uncategorized
   * transactions also receive the chosen category (manual categorizations,
   * transfers, and split parents are left untouched). Setting the default
   * category and backfilling span two tables, so the whole batch runs in one
   * transaction.
   */
  async applyCategorySuggestions(
    userId: string,
    assignments: Array<{
      payeeId: string;
      categoryId: string;
      backfillTransactions?: boolean;
    }>,
  ): Promise<{ updated: number; transactionsBackfilled: number }> {
    // M24: Batch-verify all categoryIds belong to the user
    const uniqueCategoryIds = [
      ...new Set(assignments.map((a) => a.categoryId)),
    ];
    if (uniqueCategoryIds.length > 0) {
      const ownedCategories = await this.categoriesRepository.find({
        where: { id: In(uniqueCategoryIds), userId },
        select: ["id"],
      });
      const ownedCategoryIds = new Set(ownedCategories.map((c) => c.id));
      const invalidIds = uniqueCategoryIds.filter(
        (id) => !ownedCategoryIds.has(id),
      );
      if (invalidIds.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.payees.categoryIdsNotOwned",
            `Category IDs not found or not owned by user: ${invalidIds.join(", ")}`,
            { ids: invalidIds.join(", ") },
          ),
        );
      }
    }

    const payeeIds = [...new Set(assignments.map((a) => a.payeeId))];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const payees = await queryRunner.manager.find(Payee, {
        where: { id: In(payeeIds), userId },
      });
      const payeeMap = new Map(payees.map((p) => [p.id, p]));

      const toSave: Payee[] = [];
      let transactionsBackfilled = 0;
      for (const assignment of assignments) {
        const payee = payeeMap.get(assignment.payeeId);
        if (!payee) continue;
        payee.defaultCategoryId = assignment.categoryId;
        toSave.push(payee);

        if (assignment.backfillTransactions) {
          transactionsBackfilled += await backfillPayeeCategory(
            queryRunner.manager,
            userId,
            assignment.payeeId,
            assignment.categoryId,
          );
        }
      }

      if (toSave.length > 0) {
        await queryRunner.manager.save(toSave);
      }

      await queryRunner.commitTransaction();
      return { updated: toSave.length, transactionsBackfilled };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ===== Alias Methods =====

  /**
   * Get all aliases for a specific payee.
   */
  async getAliases(userId: string, payeeId: string): Promise<PayeeAlias[]> {
    await this.findOne(userId, payeeId);
    return this.aliasRepository.find({
      where: { payeeId, userId },
      order: { alias: "ASC" },
    });
  }

  /**
   * Get all aliases for the user (across all payees).
   */
  async getAllAliases(userId: string): Promise<PayeeAlias[]> {
    return this.aliasRepository.find({
      where: { userId },
      relations: ["payee"],
      order: { alias: "ASC" },
    });
  }

  /**
   * Create a new alias for a payee.
   * Validates that the alias doesn't conflict with existing aliases.
   */
  async createAlias(
    userId: string,
    dto: CreatePayeeAliasDto,
  ): Promise<PayeeAlias> {
    // Verify the payee exists and belongs to the user
    await this.findOne(userId, dto.payeeId);

    const trimmedAlias = dto.alias.trim();
    if (!trimmedAlias) {
      throw new BadRequestException(
        tr("errors.payees.aliasEmpty", "Alias cannot be empty"),
      );
    }

    // Check for exact duplicate alias (case-insensitive)
    const existingExact = await this.aliasRepository
      .createQueryBuilder("alias")
      .where("alias.user_id = :userId", { userId })
      .andWhere("LOWER(alias.alias) = LOWER(:alias)", { alias: trimmedAlias })
      .leftJoinAndSelect("alias.payee", "payee")
      .getOne();

    if (existingExact) {
      throw new ConflictException(
        tr(
          "errors.payees.aliasDuplicate",
          `Alias "${trimmedAlias}" is already assigned to payee "${existingExact.payee?.name || "unknown"}"`,
          {
            alias: trimmedAlias,
            payeeName: existingExact.payee?.name || "unknown",
          },
        ),
      );
    }

    // Check for overlapping wildcard patterns
    const allAliases = await this.aliasRepository.find({
      where: { userId },
      relations: ["payee"],
    });

    for (const existing of allAliases) {
      // Check if the new alias would match any existing alias patterns
      if (matchesAliasPattern(trimmedAlias, existing.alias)) {
        throw new ConflictException(
          tr(
            "errors.payees.aliasOverlap",
            `Alias "${trimmedAlias}" overlaps with existing alias "${existing.alias}" on payee "${existing.payee?.name || "unknown"}". Consider modifying one of them.`,
            {
              alias: trimmedAlias,
              existingAlias: existing.alias,
              payeeName: existing.payee?.name || "unknown",
            },
          ),
        );
      }
      // Check if any existing alias pattern would match the new one
      if (matchesAliasPattern(existing.alias, trimmedAlias)) {
        throw new ConflictException(
          tr(
            "errors.payees.aliasOverlap",
            `Alias "${trimmedAlias}" overlaps with existing alias "${existing.alias}" on payee "${existing.payee?.name || "unknown"}". Consider modifying one of them.`,
            {
              alias: trimmedAlias,
              existingAlias: existing.alias,
              payeeName: existing.payee?.name || "unknown",
            },
          ),
        );
      }
    }

    const alias = this.aliasRepository.create({
      payeeId: dto.payeeId,
      userId,
      alias: trimmedAlias,
    });

    return this.aliasRepository.save(alias);
  }

  /**
   * Delete an alias by ID.
   */
  async removeAlias(userId: string, aliasId: string): Promise<void> {
    const alias = await this.aliasRepository.findOne({
      where: { id: aliasId, userId },
    });

    if (!alias) {
      throw new NotFoundException(
        tr(
          "errors.payees.aliasNotFound",
          `Alias with ID ${aliasId} not found`,
          { id: aliasId },
        ),
      );
    }

    await this.aliasRepository.remove(alias);
  }

  /**
   * Find a payee by matching an imported name against aliases.
   * Returns the payee if a matching alias is found, null otherwise.
   * Case-insensitive, supports * wildcards in alias patterns.
   */
  async findPayeeByAlias(
    userId: string,
    importedName: string,
    queryRunner?: any,
  ): Promise<Payee | null> {
    const manager = queryRunner?.manager ?? this.aliasRepository.manager;

    // Load all aliases for this user and check for matches
    const aliases = await manager.find(PayeeAlias, {
      where: { userId },
      relations: ["payee", "payee.defaultCategory"],
    });

    for (const alias of aliases) {
      if (matchesAliasPattern(importedName, alias.alias)) {
        return alias.payee ?? null;
      }
    }

    return null;
  }

  /**
   * Merge one payee into another:
   * 1. Reassign all transactions from source to target payee
   * 2. Optionally add the source payee name as an alias on the target
   * 3. Delete the source payee
   *
   * Uses a QueryRunner transaction for atomicity.
   */
  async mergePayees(
    userId: string,
    dto: MergePayeeDto,
  ): Promise<{
    transactionsMigrated: number;
    aliasAdded: boolean;
    sourcePayeeDeleted: boolean;
  }> {
    const { targetPayeeId, sourcePayeeId, addAsAlias = true } = dto;

    if (targetPayeeId === sourcePayeeId) {
      throw new BadRequestException(
        tr("errors.payees.mergeSelf", "Cannot merge a payee into itself"),
      );
    }

    // Verify both payees exist and belong to the user
    const targetPayee = await this.findOne(userId, targetPayeeId);
    const sourcePayee = await this.findOne(userId, sourcePayeeId);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Reassign transactions from source to target
      const txResult = await queryRunner.manager.update(
        Transaction,
        { payeeId: sourcePayeeId, userId },
        { payeeId: targetPayeeId, payeeName: targetPayee.name },
      );
      const transactionsMigrated = txResult.affected || 0;

      // Also reassign scheduled transactions
      await queryRunner.manager.update(
        ScheduledTransaction,
        { payeeId: sourcePayeeId, userId },
        { payeeId: targetPayeeId, payeeName: targetPayee.name },
      );

      // 2. Optionally add source payee name as alias on target
      let aliasAdded = false;
      if (addAsAlias) {
        // Check if the alias already exists
        const existingAlias = await queryRunner.manager
          .createQueryBuilder(PayeeAlias, "alias")
          .where("alias.user_id = :userId", { userId })
          .andWhere("LOWER(alias.alias) = LOWER(:alias)", {
            alias: sourcePayee.name,
          })
          .getOne();

        if (!existingAlias) {
          const newAlias = queryRunner.manager.create(PayeeAlias, {
            payeeId: targetPayeeId,
            userId,
            alias: sourcePayee.name,
          });
          await queryRunner.manager.save(newAlias);
          aliasAdded = true;
        }
      }

      // 3. Move any aliases from source payee to target payee
      await queryRunner.manager.update(
        PayeeAlias,
        { payeeId: sourcePayeeId, userId },
        { payeeId: targetPayeeId },
      );

      // 4. Delete the source payee
      await queryRunner.manager.remove(Payee, sourcePayee);

      await queryRunner.commitTransaction();

      return {
        transactionsMigrated,
        aliasAdded,
        sourcePayeeDeleted: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
