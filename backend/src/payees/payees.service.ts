import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Like, In } from "typeorm";
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
  ): Promise<(Payee & { transactionCount: number })[]> {
    // Get all payees with their default category
    const payees = await this.payeesRepository.find({
      where: { userId },
      relations: ["defaultCategory"],
      order: { name: "ASC" },
    });

    if (payees.length === 0) {
      return [];
    }

    // Get transaction counts for all payees in one query
    const counts = await this.payeesRepository
      .createQueryBuilder("payee")
      .leftJoin(
        "transactions",
        "transaction",
        "transaction.payee_id = payee.id AND transaction.user_id = :userId",
        { userId },
      )
      .where("payee.user_id = :userId", { userId })
      .groupBy("payee.id")
      .select(["payee.id as id", "COUNT(transaction.id) as count"])
      .getRawMany();

    // Create a map of payee ID to transaction count
    const countMap = new Map<string, number>();
    for (const row of counts) {
      countMap.set(row.id, parseInt(row.count || "0", 10));
    }

    // Merge counts with payees
    return payees.map((payee) => ({
      ...payee,
      transactionCount: countMap.get(payee.id) || 0,
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
        name: Like(`%${escapeLikeWildcards(query)}%`),
      },
      relations: ["defaultCategory"],
      order: { name: "ASC" },
      take: limit,
    });
  }

  async autocomplete(userId: string, query: string): Promise<Payee[]> {
    // Return payees that start with the query (for autocomplete)
    return this.payeesRepository.find({
      where: {
        userId,
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
      .groupBy("payee.id")
      .addGroupBy("defaultCategory.id")
      .orderBy("COUNT(transaction.id)", "DESC")
      .limit(limit)
      .getMany();
  }

  async getRecentlyUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Single query: join defaultCategory + aggregate most recent date, avoiding two-step fetch
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

    return {
      totalPayees,
      payeesWithCategory,
      payeesWithoutCategory: totalPayees - payeesWithCategory,
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

// Import these at the top with other imports
import { Not, IsNull } from "typeorm";
