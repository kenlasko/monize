import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, IsNull } from "typeorm";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
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

    return this.categoriesRepository.save(category);
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

    const countMap = new Map<string, number>();
    for (const row of directCounts) {
      countMap.set(row.categoryId, parseInt(row.count || "0", 10));
    }
    for (const row of splitCounts) {
      const existing = countMap.get(row.categoryId) || 0;
      countMap.set(row.categoryId, existing + parseInt(row.count || "0", 10));
    }

    return categories.map((category) => ({
      ...category,
      transactionCount: countMap.get(category.id) || 0,
    }));
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

  async findByType(userId: string, isIncome: boolean): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: { userId, isIncome },
      order: { name: "ASC" },
    });
  }

  async findOne(userId: string, id: string): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ["children"],
    });

    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    if (category.userId !== userId) {
      throw new ForbiddenException("You do not have access to this category");
    }

    return category;
  }

  async update(
    userId: string,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException("Cannot modify system categories");
    }

    if (updateCategoryDto.parentId) {
      if (updateCategoryDto.parentId === id) {
        throw new BadRequestException("Category cannot be its own parent");
      }
      await this.findOne(userId, updateCategoryDto.parentId);
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

    return this.categoriesRepository.save(category);
  }

  async remove(userId: string, id: string): Promise<void> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException("Cannot delete system categories");
    }

    const childCount = await this.categoriesRepository.count({
      where: { parentId: id },
    });

    if (childCount > 0) {
      throw new BadRequestException(
        "Cannot delete category with subcategories. Delete or reassign subcategories first.",
      );
    }

    await this.payeesRepository.update(
      { userId, defaultCategoryId: id },
      { defaultCategoryId: null },
    );

    await this.categoriesRepository.remove(category);
  }

  async getTransactionCount(
    userId: string,
    categoryId: string,
  ): Promise<number> {
    await this.findOne(userId, categoryId);

    const [transactionCount, splitCount, scheduledCount, userScheduledTxIds] =
      await Promise.all([
        this.transactionsRepository.count({ where: { userId, categoryId } }),
        this.splitsRepository.count({ where: { categoryId } }),
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

    const transactionResult = await this.transactionsRepository.update(
      { userId, categoryId: fromCategoryId },
      { categoryId: toCategoryId },
    );

    const userTransactionIds = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .getMany();

    const transactionIds = userTransactionIds.map((t) => t.id);

    let splitsUpdated = 0;
    if (transactionIds.length > 0) {
      const splitResult = await this.splitsRepository
        .createQueryBuilder()
        .update(TransactionSplit)
        .set({ categoryId: toCategoryId })
        .where("categoryId = :fromCategoryId", { fromCategoryId })
        .andWhere("transactionId IN (:...transactionIds)", { transactionIds })
        .execute();

      splitsUpdated = splitResult.affected || 0;
    }

    const scheduledResult = await this.scheduledTransactionsRepository.update(
      { userId, categoryId: fromCategoryId },
      { categoryId: toCategoryId },
    );

    const userScheduledTxIds = await this.scheduledTransactionsRepository
      .createQueryBuilder("st")
      .select("st.id")
      .where("st.userId = :userId", { userId })
      .getMany();

    if (userScheduledTxIds.length > 0) {
      const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
      await this.scheduledSplitsRepository
        .createQueryBuilder()
        .update(ScheduledTransactionSplit)
        .set({ categoryId: toCategoryId })
        .where("categoryId = :fromCategoryId", { fromCategoryId })
        .andWhere("scheduledTransactionId IN (:...scheduledTxIds)", {
          scheduledTxIds,
        })
        .execute();
    }

    return {
      transactionsUpdated: transactionResult.affected || 0,
      splitsUpdated,
      scheduledUpdated: scheduledResult.affected || 0,
    };
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
        "Cannot import defaults: user already has categories. Delete existing categories first or start fresh.",
      );
    }

    let categoryCount = 0;

    for (const cat of DEFAULT_INCOME_CATEGORIES) {
      const parentCategory = this.categoriesRepository.create({
        userId,
        name: cat.name,
        isIncome: true,
      });
      const savedParent = await this.categoriesRepository.save(parentCategory);
      categoryCount++;

      for (const subName of cat.subcategories) {
        const subCategory = this.categoriesRepository.create({
          userId,
          parentId: savedParent.id,
          name: subName,
          isIncome: true,
        });
        await this.categoriesRepository.save(subCategory);
        categoryCount++;
      }
    }

    for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
      const parentCategory = this.categoriesRepository.create({
        userId,
        name: cat.name,
        isIncome: false,
      });
      const savedParent = await this.categoriesRepository.save(parentCategory);
      categoryCount++;

      for (const subName of cat.subcategories) {
        const subCategory = this.categoriesRepository.create({
          userId,
          parentId: savedParent.id,
          name: subName,
          isIncome: false,
        });
        await this.categoriesRepository.save(subCategory);
        categoryCount++;
      }
    }

    return { categoriesCreated: categoryCount };
  }
}
