import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Like, In, Not, IsNull } from "typeorm";
import { Payee } from "./entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { UpdatePayeeDto } from "./dto/update-payee.dto";

function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

@Injectable()
export class PayeesService {
  constructor(
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
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
        `Payee with name "${createPayeeDto.name}" already exists`,
      );
    }

    const payee = this.payeesRepository.create({
      ...createPayeeDto,
      userId,
    });

    return this.payeesRepository.save(payee);
  }

  async findAll(
    userId: string,
    status?: "active" | "inactive" | "all",
  ): Promise<
    (Payee & { transactionCount: number; lastUsedDate: string | null })[]
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

    // Create maps for counts and last used dates
    const countMap = new Map<string, number>();
    const lastUsedMap = new Map<string, string | null>();
    for (const row of stats) {
      countMap.set(row.id, parseInt(row.count || "0", 10));
      lastUsedMap.set(row.id, row.last_used_date || null);
    }

    // Merge stats with payees
    return payees.map((payee) => ({
      ...payee,
      transactionCount: countMap.get(payee.id) || 0,
      lastUsedDate: lastUsedMap.get(payee.id) || null,
    }));
  }

  async findOne(userId: string, id: string): Promise<Payee> {
    const payee = await this.payeesRepository.findOne({
      where: { id, userId },
      relations: ["defaultCategory"],
    });

    if (!payee) {
      throw new NotFoundException(`Payee with ID ${id} not found`);
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
  ): Promise<Payee> {
    const payee = await this.findOne(userId, id);

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
          `Payee with name "${updatePayeeDto.name}" already exists`,
        );
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    const nameChanged =
      updatePayeeDto.name !== undefined && updatePayeeDto.name !== payee.name;
    if (updatePayeeDto.name !== undefined) payee.name = updatePayeeDto.name;
    if (updatePayeeDto.defaultCategoryId !== undefined)
      payee.defaultCategoryId = updatePayeeDto.defaultCategoryId;
    if (updatePayeeDto.notes !== undefined) payee.notes = updatePayeeDto.notes;
    if (updatePayeeDto.isActive !== undefined)
      payee.isActive = updatePayeeDto.isActive;

    const saved = await this.payeesRepository.save(payee);

    // Cascade name change to existing transactions and scheduled transactions
    if (nameChanged) {
      await this.transactionsRepository.update(
        { payeeId: id, userId },
        { payeeName: updatePayeeDto.name },
      );
      await this.scheduledTransactionsRepository.update(
        { payeeId: id, userId },
        { payeeName: updatePayeeDto.name },
      );
    }

    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const payee = await this.findOne(userId, id);
    await this.payeesRepository.remove(payee);
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
    const totalCountMap = new Map<string, number>();
    for (const row of totalCounts) {
      totalCountMap.set(row.payee_id, parseInt(row.total_count, 10));
    }

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
        });
      }
    }

    // Sort by payee name
    suggestions.sort((a, b) => a.payeeName.localeCompare(b.payeeName));

    return suggestions;
  }

  /**
   * Apply category suggestions to payees (bulk update)
   */
  async applyCategorySuggestions(
    userId: string,
    assignments: Array<{ payeeId: string; categoryId: string }>,
  ): Promise<{ updated: number }> {
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
          `Category IDs not found or not owned by user: ${invalidIds.join(", ")}`,
        );
      }
    }

    const payeeIds = [...new Set(assignments.map((a) => a.payeeId))];
    const payees = await this.payeesRepository.find({
      where: { id: In(payeeIds), userId },
    });
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    const toSave: Payee[] = [];
    for (const assignment of assignments) {
      const payee = payeeMap.get(assignment.payeeId);
      if (payee) {
        payee.defaultCategoryId = assignment.categoryId;
        toSave.push(payee);
      }
    }

    if (toSave.length > 0) {
      await this.payeesRepository.save(toSave);
    }

    return { updated: toSave.length };
  }
}
