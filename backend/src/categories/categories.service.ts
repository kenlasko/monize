import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, IsNull, DataSource, EntityManager } from "typeorm";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { toCountMap } from "../common/count-map.util";
import {
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_EXPENSE_CATEGORIES,
} from "./default-categories";

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(ScheduledTransactionSplit)
    private scheduledSplitsRepository: Repository<ScheduledTransactionSplit>,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(
    userId: string,
    createCategoryDto: CreateCategoryDto,
  ): Promise<Category> {
    let isIncome = createCategoryDto.isIncome ?? false;

    if (createCategoryDto.parentId) {
      const parent = await this.findOne(userId, createCategoryDto.parentId);
      isIncome = parent.isIncome;
    }

    const category = this.categoriesRepository.create({
      ...createCategoryDto,
      isIncome,
      userId,
    });

    const saved = await this.categoriesRepository.save(category);
    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        description: saved.description,
        icon: saved.icon,
        color: saved.color,
        isIncome: saved.isIncome,
        parentId: saved.parentId,
        isSystem: saved.isSystem,
      },
      description: `Created category "${saved.name}"`,
      descriptionKey: "createdCategory",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  private resolveEffectiveColors<
    T extends { id: string; parentId: string | null; color: string | null },
  >(categories: T[]): (T & { effectiveColor: string | null })[] {
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const resolved = new Map<string, string | null>();

    const getEffectiveColor = (cat: T): string | null => {
      if (resolved.has(cat.id)) {
        return resolved.get(cat.id)!;
      }
      if (cat.color !== null) {
        resolved.set(cat.id, cat.color);
        return cat.color;
      }
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          const parentColor = getEffectiveColor(parent);
          resolved.set(cat.id, parentColor);
          return parentColor;
        }
      }
      resolved.set(cat.id, null);
      return null;
    };

    return categories.map((cat) => ({
      ...cat,
      effectiveColor: getEffectiveColor(cat),
    }));
  }

  async findAll(
    userId: string,
    includeSystem = false,
  ): Promise<(Category & { transactionCount: number })[]> {
    const queryBuilder = this.categoriesRepository
      .createQueryBuilder("category")
      .where("category.userId = :userId", { userId })
      .orderBy("category.name", "ASC");

    if (!includeSystem) {
      queryBuilder.andWhere("category.isSystem = :isSystem", {
        isSystem: false,
      });
    }

    const categories = await queryBuilder.getMany();

    if (categories.length === 0) {
      return [];
    }

    const categoryIds = categories.map((c) => c.id);

    const [directCounts, splitCounts] = await Promise.all([
      this.transactionsRepository
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect("COUNT(t.id)", "count")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .groupBy("t.category_id")
        .getRawMany(),
      this.splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect("COUNT(s.id)", "count")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .groupBy("s.category_id")
        .getRawMany(),
    ]);

    const countMap = toCountMap(directCounts, { keyField: "categoryId" });
    toCountMap(splitCounts, { keyField: "categoryId", into: countMap });

    const categoriesWithCounts = categories.map((category) => ({
      ...category,
      transactionCount: countMap.get(category.id) || 0,
    }));

    return this.resolveEffectiveColors(categoriesWithCounts);
  }

  async getTree(
    userId: string,
  ): Promise<(Category & { transactionCount: number })[]> {
    const allCategories = await this.findAll(userId, false);

    const categoryMap = new Map<
      string,
      Category & { children: Category[]; transactionCount: number }
    >();
    const rootCategories: (Category & {
      children: Category[];
      transactionCount: number;
    })[] = [];

    allCategories.forEach((cat) => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });

    allCategories.forEach((cat) => {
      const category = categoryMap.get(cat.id)!;
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          parent.children.push(category);
        } else {
          rootCategories.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });

    return rootCategories;
  }

  async findByType(
    userId: string,
    isIncome: boolean,
  ): Promise<(Category & { effectiveColor: string | null })[]> {
    const categories = await this.categoriesRepository.find({
      where: { userId, isIncome },
      order: { name: "ASC" },
    });

    return this.resolveEffectiveColors(categories);
  }

  /**
   * LLM-friendly category listing: returns a flat list with parent names so
   * the model can understand hierarchy without parsing nested JSON. Used by
   * both the AI Assistant and the MCP server to keep response shapes in sync.
   *
   * - `type` narrows to expense or income categories; 'all' (default)
   *   returns both.
   * - `search` is a case-insensitive substring match on category name. If the
   *   matching category is a subcategory, its parent is included so the LLM
   *   sees the hierarchy context.
   */
  async getLlmCategories(
    userId: string,
    options: {
      type?: "expense" | "income" | "all";
      search?: string;
    } = {},
  ): Promise<{
    categories: Array<{
      id: string;
      name: string;
      parentName: string | null;
      isIncome: boolean;
      transactionCount: number;
    }>;
    totalCount: number;
  }> {
    const type = options.type ?? "all";
    const search = options.search?.trim().toLowerCase();

    const all = await this.findAll(userId, false);
    const byId = new Map(all.map((c) => [c.id, c]));

    let filtered = all;
    if (type !== "all") {
      const wantIncome = type === "income";
      filtered = filtered.filter((c) => c.isIncome === wantIncome);
    }

    if (search) {
      const matchIds = new Set(
        filtered
          .filter((c) => c.name.toLowerCase().includes(search))
          .map((c) => c.id),
      );
      // Include parents of matched subcategories so hierarchy stays intact.
      for (const id of Array.from(matchIds)) {
        const cat = byId.get(id);
        if (cat?.parentId) matchIds.add(cat.parentId);
      }
      filtered = filtered.filter((c) => matchIds.has(c.id));
    }

    const categories = filtered
      .map((c) => ({
        id: c.id,
        name: c.name,
        parentName: c.parentId ? (byId.get(c.parentId)?.name ?? null) : null,
        isIncome: c.isIncome,
        transactionCount: c.transactionCount,
      }))
      .sort((a, b) => {
        // Parents first, then children, both alphabetized
        const aKey = a.parentName ?? a.name;
        const bKey = b.parentName ?? b.name;
        if (aKey !== bKey) return aKey.localeCompare(bKey);
        if (a.parentName === null && b.parentName !== null) return -1;
        if (a.parentName !== null && b.parentName === null) return 1;
        return a.name.localeCompare(b.name);
      });

    return {
      categories,
      totalCount: categories.length,
    };
  }

  async findOne(
    userId: string,
    id: string,
  ): Promise<Category & { effectiveColor: string | null }> {
    const category = await this.categoriesRepository.findOne({
      where: { id, userId },
      relations: ["children"],
    });

    if (!category) {
      throw new NotFoundException(
        tr("errors.categories.notFound", `Category with ID ${id} not found`, {
          id,
        }),
      );
    }

    let effectiveColor = category.color;
    if (effectiveColor === null && category.parentId) {
      let currentParentId: string | null = category.parentId;
      while (currentParentId !== null && effectiveColor === null) {
        const parent = await this.categoriesRepository.findOne({
          where: { id: currentParentId, userId },
          select: ["id", "color", "parentId"],
        });
        if (parent) {
          effectiveColor = parent.color;
          currentParentId = parent.parentId;
        } else {
          break;
        }
      }
    }

    return { ...category, effectiveColor };
  }

  async update(
    userId: string,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    const category = await this.findOne(userId, id);
    const beforeData = {
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      isIncome: category.isIncome,
      parentId: category.parentId,
    };

    if (category.isSystem) {
      throw new BadRequestException(
        tr(
          "errors.categories.cannotModifySystem",
          "Cannot modify system categories",
        ),
      );
    }

    if (updateCategoryDto.parentId) {
      if (updateCategoryDto.parentId === id) {
        throw new BadRequestException(
          tr(
            "errors.categories.selfParent",
            "Category cannot be its own parent",
          ),
        );
      }
      await this.findOne(userId, updateCategoryDto.parentId);

      // H16: Check for circular parent reference through the hierarchy
      const allCategories = await this.categoriesRepository.find({
        where: { userId },
        select: ["id", "parentId"],
      });
      const categoryMap = new Map(allCategories.map((c) => [c.id, c.parentId]));
      categoryMap.set(id, updateCategoryDto.parentId);
      let current: string | null | undefined = updateCategoryDto.parentId;
      const visited = new Set<string>([id]);
      while (current) {
        if (visited.has(current)) {
          throw new BadRequestException(
            tr(
              "errors.categories.circularParent",
              "Circular parent reference detected",
            ),
          );
        }
        visited.add(current);
        current = categoryMap.get(current) ?? null;
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateCategoryDto.name !== undefined)
      category.name = updateCategoryDto.name;
    if (updateCategoryDto.description !== undefined)
      category.description = updateCategoryDto.description;
    if (updateCategoryDto.icon !== undefined)
      category.icon = updateCategoryDto.icon;
    if (updateCategoryDto.color !== undefined)
      category.color = updateCategoryDto.color;
    if (updateCategoryDto.parentId !== undefined)
      category.parentId = updateCategoryDto.parentId;

    // Inherit type from parent - child categories must match parent type
    if (category.parentId) {
      const parent = await this.findOne(userId, category.parentId);
      category.isIncome = parent.isIncome;
    } else if (updateCategoryDto.isIncome !== undefined) {
      category.isIncome = updateCategoryDto.isIncome;
    }

    // Save the category and cascade any type change to all descendant
    // subcategories atomically, so a partial failure cannot leave children
    // with a type that disagrees with their parent.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let saved: Category;
    try {
      // Pass the explicit entity target: findOne returns a plain object
      // (spread with effectiveColor), not a Category instance, so the
      // single-arg form would throw CannotDetermineEntityError.
      saved = await queryRunner.manager.save(Category, category);

      if (
        !category.parentId &&
        updateCategoryDto.isIncome !== undefined &&
        updateCategoryDto.isIncome !== beforeData.isIncome
      ) {
        await this.updateDescendantTypes(
          userId,
          id,
          saved.isIncome,
          queryRunner.manager,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: id,
      action: "update",
      beforeData,
      afterData: {
        name: saved.name,
        description: saved.description,
        icon: saved.icon,
        color: saved.color,
        isIncome: saved.isIncome,
        parentId: saved.parentId,
      },
      description: `Updated category "${saved.name}"`,
      descriptionKey: "updatedCategory",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  private async updateDescendantTypes(
    userId: string,
    parentId: string,
    isIncome: boolean,
    manager: EntityManager,
  ): Promise<void> {
    const children = await manager.find(Category, {
      where: { userId, parentId },
      select: ["id"],
    });

    if (children.length === 0) {
      return;
    }

    for (const child of children) {
      await manager.update(Category, { id: child.id, userId }, { isIncome });
      await this.updateDescendantTypes(userId, child.id, isIncome, manager);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException(
        tr(
          "errors.categories.cannotDeleteSystem",
          "Cannot delete system categories",
        ),
      );
    }

    const childCount = await this.categoriesRepository.count({
      where: { parentId: id, userId },
    });

    if (childCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.hasSubcategories",
          "Cannot delete category with subcategories. Delete or reassign subcategories first.",
        ),
      );
    }

    // M23: Check for referencing transactions before deletion
    const transactionCount = await this.getTransactionCount(userId, id);
    if (transactionCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.hasTransactions",
          `Cannot delete category with ${transactionCount} referencing transaction(s). Reassign transactions first.`,
          { count: transactionCount },
        ),
      );
    }

    const beforeData = {
      id: category.id,
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      isIncome: category.isIncome,
      parentId: category.parentId,
      isSystem: category.isSystem,
    };

    // Clear the default-category reference on any payees and delete the
    // category atomically, so a failure cannot leave payees pointing at a
    // category that no longer exists.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.manager.update(
        Payee,
        { userId, defaultCategoryId: id },
        { defaultCategoryId: null },
      );
      // Explicit entity target: `category` here is a plain object from
      // findOne (spread with effectiveColor), not a Category instance.
      await queryRunner.manager.remove(Category, category);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted category "${beforeData.name}"`,
      descriptionKey: "deletedCategory",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getTransactionCount(
    userId: string,
    categoryId: string,
  ): Promise<number> {
    await this.findOne(userId, categoryId);

    const [transactionCount, splitCount, scheduledCount, userScheduledTxIds] =
      await Promise.all([
        this.transactionsRepository.count({ where: { userId, categoryId } }),
        this.splitsRepository
          .createQueryBuilder("split")
          .innerJoin("split.transaction", "transaction")
          .where("split.categoryId = :categoryId", { categoryId })
          .andWhere("transaction.userId = :userId", { userId })
          .getCount(),
        this.scheduledTransactionsRepository.count({
          where: { userId, categoryId },
        }),
        this.scheduledTransactionsRepository
          .createQueryBuilder("st")
          .select("st.id")
          .where("st.userId = :userId", { userId })
          .getMany(),
      ]);

    let scheduledSplitCount = 0;
    if (userScheduledTxIds.length > 0) {
      const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
      scheduledSplitCount = await this.scheduledSplitsRepository
        .createQueryBuilder("ss")
        .where("ss.categoryId = :categoryId", { categoryId })
        .andWhere("ss.scheduledTransactionId IN (:...scheduledTxIds)", {
          scheduledTxIds,
        })
        .getCount();
    }

    return transactionCount + splitCount + scheduledCount + scheduledSplitCount;
  }

  async reassignTransactions(
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{
    transactionsUpdated: number;
    splitsUpdated: number;
    scheduledUpdated: number;
  }> {
    await this.findOne(userId, fromCategoryId);

    if (toCategoryId) {
      await this.findOne(userId, toCategoryId);
    }

    // M22: Wrap all UPDATE operations in a single QueryRunner transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transactionResult = await queryRunner.manager.update(
        Transaction,
        { userId, categoryId: fromCategoryId },
        { categoryId: toCategoryId },
      );

      const userTransactionIds = await queryRunner.manager
        .createQueryBuilder(Transaction, "t")
        .select("t.id")
        .where("t.userId = :userId", { userId })
        .getMany();

      const transactionIds = userTransactionIds.map((t) => t.id);

      let splitsUpdated = 0;
      if (transactionIds.length > 0) {
        const splitResult = await queryRunner.manager
          .createQueryBuilder()
          .update(TransactionSplit)
          .set({ categoryId: toCategoryId })
          .where("categoryId = :fromCategoryId", { fromCategoryId })
          .andWhere("transactionId IN (:...transactionIds)", { transactionIds })
          .execute();

        splitsUpdated = splitResult.affected || 0;
      }

      const scheduledResult = await queryRunner.manager.update(
        ScheduledTransaction,
        { userId, categoryId: fromCategoryId },
        { categoryId: toCategoryId },
      );

      const userScheduledTxIds = await queryRunner.manager
        .createQueryBuilder(ScheduledTransaction, "st")
        .select("st.id")
        .where("st.userId = :userId", { userId })
        .getMany();

      if (userScheduledTxIds.length > 0) {
        const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
        await queryRunner.manager
          .createQueryBuilder()
          .update(ScheduledTransactionSplit)
          .set({ categoryId: toCategoryId })
          .where("categoryId = :fromCategoryId", { fromCategoryId })
          .andWhere("scheduledTransactionId IN (:...scheduledTxIds)", {
            scheduledTxIds,
          })
          .execute();
      }

      await queryRunner.commitTransaction();

      return {
        transactionsUpdated: transactionResult.affected || 0,
        splitsUpdated,
        scheduledUpdated: scheduledResult.affected || 0,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getStats(userId: string): Promise<{
    totalCategories: number;
    incomeCategories: number;
    expenseCategories: number;
    subcategories: number;
  }> {
    const categories = await this.findAll(userId, false);

    const incomeCategories = categories.filter((c) => c.isIncome).length;
    const expenseCategories = categories.filter((c) => !c.isIncome).length;
    const subcategories = categories.filter((c) => c.parentId !== null).length;

    return {
      totalCategories: categories.length,
      incomeCategories,
      expenseCategories,
      subcategories,
    };
  }

  async findByName(
    userId: string,
    name: string,
    parentName?: string,
  ): Promise<Category | null> {
    if (parentName) {
      const parent = await this.categoriesRepository.findOne({
        where: { userId, name: parentName, parentId: IsNull() },
      });

      if (!parent) {
        return null;
      }

      return this.categoriesRepository.findOne({
        where: { userId, name, parentId: parent.id },
      });
    }

    return this.categoriesRepository.findOne({
      where: { userId, name },
    });
  }

  async findLoanCategories(userId: string): Promise<{
    principalCategory: Category | null;
    interestCategory: Category | null;
  }> {
    const loanParent = await this.categoriesRepository.findOne({
      where: { userId, name: "Loan", parentId: IsNull() },
    });

    if (!loanParent) {
      return {
        principalCategory: null,
        interestCategory: null,
      };
    }

    const [principalCategory, interestCategory] = await Promise.all([
      this.categoriesRepository.findOne({
        where: { userId, name: "Loan Principal", parentId: loanParent.id },
      }),
      this.categoriesRepository.findOne({
        where: { userId, name: "Loan Interest", parentId: loanParent.id },
      }),
    ]);

    return { principalCategory, interestCategory };
  }

  async importDefaults(userId: string): Promise<{ categoriesCreated: number }> {
    const existingCount = await this.categoriesRepository.count({
      where: { userId, isSystem: false },
    });

    if (existingCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.alreadyHasCategories",
          "Cannot import defaults: user already has categories. Delete existing categories first or start fresh.",
        ),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(Category);
      let categoryCount = 0;

      for (const cat of DEFAULT_INCOME_CATEGORIES) {
        const parentCategory = repo.create({
          userId,
          name: cat.name,
          isIncome: true,
        });
        const savedParent = await repo.save(parentCategory);
        categoryCount++;

        for (const subName of cat.subcategories) {
          const subCategory = repo.create({
            userId,
            parentId: savedParent.id,
            name: subName,
            isIncome: true,
          });
          await repo.save(subCategory);
          categoryCount++;
        }
      }

      for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
        const parentCategory = repo.create({
          userId,
          name: cat.name,
          isIncome: false,
        });
        const savedParent = await repo.save(parentCategory);
        categoryCount++;

        for (const subName of cat.subcategories) {
          const subCategory = repo.create({
            userId,
            parentId: savedParent.id,
            name: subName,
            isIncome: false,
          });
          await repo.save(subCategory);
          categoryCount++;
        }
      }

      await queryRunner.commitTransaction();
      return { categoriesCreated: categoryCount };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
