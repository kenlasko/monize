import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Category } from './entities/category.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionSplit } from '../transactions/entities/transaction-split.entity';
import { Payee } from '../payees/entities/payee.entity';
import { ScheduledTransaction } from '../scheduled-transactions/entities/scheduled-transaction.entity';
import { ScheduledTransactionSplit } from '../scheduled-transactions/entities/scheduled-transaction-split.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

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

  /**
   * Create a new category
   */
  async create(
    userId: string,
    createCategoryDto: CreateCategoryDto,
  ): Promise<Category> {
    // If parent category is specified, verify it exists and belongs to user
    if (createCategoryDto.parentId) {
      await this.findOne(userId, createCategoryDto.parentId);
    }

    const category = this.categoriesRepository.create({
      ...createCategoryDto,
      userId,
    });

    return this.categoriesRepository.save(category);
  }

  /**
   * Find all categories for a user
   */
  async findAll(userId: string, includeSystem = false): Promise<Category[]> {
    const queryBuilder = this.categoriesRepository
      .createQueryBuilder('category')
      .where('category.userId = :userId', { userId })
      .orderBy('category.name', 'ASC');

    if (!includeSystem) {
      queryBuilder.andWhere('category.isSystem = :isSystem', { isSystem: false });
    }

    return queryBuilder.getMany();
  }

  /**
   * Get category tree structure (hierarchical)
   */
  async getTree(userId: string): Promise<Category[]> {
    const allCategories = await this.findAll(userId, false);

    // Build a map for quick lookup
    const categoryMap = new Map<string, Category & { children: Category[] }>();
    const rootCategories: (Category & { children: Category[] })[] = [];

    // First pass: create map and initialize children arrays
    allCategories.forEach((cat) => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });

    // Second pass: build tree structure
    allCategories.forEach((cat) => {
      const category = categoryMap.get(cat.id)!;
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          parent.children.push(category);
        } else {
          // Parent not found, treat as root
          rootCategories.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });

    return rootCategories;
  }

  /**
   * Get categories by type (income or expense)
   */
  async findByType(userId: string, isIncome: boolean): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: {
        userId,
        isIncome,
      },
      order: {
        name: 'ASC',
      },
    });
  }

  /**
   * Find a single category by ID
   */
  async findOne(userId: string, id: string): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['children'],
    });

    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    if (category.userId !== userId) {
      throw new ForbiddenException('You do not have access to this category');
    }

    return category;
  }

  /**
   * Update a category
   */
  async update(
    userId: string,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException('Cannot modify system categories');
    }

    // If changing parent, verify new parent exists and belongs to user
    if (updateCategoryDto.parentId) {
      // Prevent circular reference
      if (updateCategoryDto.parentId === id) {
        throw new BadRequestException('Category cannot be its own parent');
      }

      await this.findOne(userId, updateCategoryDto.parentId);
    }

    Object.assign(category, updateCategoryDto);
    return this.categoriesRepository.save(category);
  }

  /**
   * Delete a category
   */
  async remove(userId: string, id: string): Promise<void> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException('Cannot delete system categories');
    }

    // Check if category has children
    const childCount = await this.categoriesRepository.count({
      where: { parentId: id },
    });

    if (childCount > 0) {
      throw new BadRequestException(
        'Cannot delete category with subcategories. Delete or reassign subcategories first.',
      );
    }

    // Clear default category from any payees using this category
    await this.payeesRepository.update(
      { userId, defaultCategoryId: id },
      { defaultCategoryId: null },
    );

    await this.categoriesRepository.remove(category);
  }

  /**
   * Get the count of transactions and scheduled items using a category
   */
  async getTransactionCount(userId: string, categoryId: string): Promise<number> {
    await this.findOne(userId, categoryId);

    // Count regular transactions
    const transactionCount = await this.transactionsRepository.count({
      where: { userId, categoryId },
    });

    // Count transaction splits
    const splitCount = await this.splitsRepository.count({
      where: { categoryId },
    });

    // Count scheduled transactions (bills & deposits)
    const scheduledCount = await this.scheduledTransactionsRepository.count({
      where: { userId, categoryId },
    });

    // Count scheduled transaction splits
    const userScheduledTxIds = await this.scheduledTransactionsRepository
      .createQueryBuilder('st')
      .select('st.id')
      .where('st.userId = :userId', { userId })
      .getMany();

    let scheduledSplitCount = 0;
    if (userScheduledTxIds.length > 0) {
      const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
      scheduledSplitCount = await this.scheduledSplitsRepository
        .createQueryBuilder('ss')
        .where('ss.categoryId = :categoryId', { categoryId })
        .andWhere('ss.scheduledTransactionId IN (:...scheduledTxIds)', { scheduledTxIds })
        .getCount();
    }

    return transactionCount + splitCount + scheduledCount + scheduledSplitCount;
  }

  /**
   * Reassign transactions from one category to another
   */
  async reassignTransactions(
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{ transactionsUpdated: number; splitsUpdated: number; scheduledUpdated: number }> {
    // Verify the source category exists and belongs to user
    await this.findOne(userId, fromCategoryId);

    // If target category is specified, verify it exists and belongs to user
    if (toCategoryId) {
      await this.findOne(userId, toCategoryId);
    }

    // Update transactions
    const transactionResult = await this.transactionsRepository.update(
      { userId, categoryId: fromCategoryId },
      { categoryId: toCategoryId },
    );

    // Update splits - need to verify splits belong to user's transactions
    const userTransactionIds = await this.transactionsRepository
      .createQueryBuilder('t')
      .select('t.id')
      .where('t.userId = :userId', { userId })
      .getMany();

    const transactionIds = userTransactionIds.map((t) => t.id);

    let splitsUpdated = 0;
    if (transactionIds.length > 0) {
      const splitResult = await this.splitsRepository
        .createQueryBuilder()
        .update(TransactionSplit)
        .set({ categoryId: toCategoryId })
        .where('categoryId = :fromCategoryId', { fromCategoryId })
        .andWhere('transactionId IN (:...transactionIds)', { transactionIds })
        .execute();

      splitsUpdated = splitResult.affected || 0;
    }

    // Update scheduled transactions (bills & deposits)
    const scheduledResult = await this.scheduledTransactionsRepository.update(
      { userId, categoryId: fromCategoryId },
      { categoryId: toCategoryId },
    );

    // Update scheduled transaction splits
    const userScheduledTxIds = await this.scheduledTransactionsRepository
      .createQueryBuilder('st')
      .select('st.id')
      .where('st.userId = :userId', { userId })
      .getMany();

    if (userScheduledTxIds.length > 0) {
      const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
      await this.scheduledSplitsRepository
        .createQueryBuilder()
        .update(ScheduledTransactionSplit)
        .set({ categoryId: toCategoryId })
        .where('categoryId = :fromCategoryId', { fromCategoryId })
        .andWhere('scheduledTransactionId IN (:...scheduledTxIds)', { scheduledTxIds })
        .execute();
    }

    return {
      transactionsUpdated: transactionResult.affected || 0,
      splitsUpdated,
      scheduledUpdated: scheduledResult.affected || 0,
    };
  }

  /**
   * Get category statistics
   */
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

  /**
   * Find a category by name (optionally under a specific parent)
   */
  async findByName(
    userId: string,
    name: string,
    parentName?: string,
  ): Promise<Category | null> {
    if (parentName) {
      // First find the parent category
      const parent = await this.categoriesRepository.findOne({
        where: { userId, name: parentName, parentId: IsNull() },
      });

      if (!parent) {
        return null;
      }

      // Then find the child category under that parent
      return this.categoriesRepository.findOne({
        where: { userId, name, parentId: parent.id },
      });
    }

    // Find top-level category by name
    return this.categoriesRepository.findOne({
      where: { userId, name },
    });
  }

  /**
   * Find loan categories (Loan Principal and Loan Interest under Loan parent)
   * Returns the categories if found, or null values if not found
   */
  async findLoanCategories(userId: string): Promise<{
    principalCategory: Category | null;
    interestCategory: Category | null;
  }> {
    // Find the Loan parent category
    const loanParent = await this.categoriesRepository.findOne({
      where: { userId, name: 'Loan', parentId: IsNull() },
    });

    if (!loanParent) {
      return {
        principalCategory: null,
        interestCategory: null,
      };
    }

    // Find Loan Principal and Loan Interest under the Loan parent
    const principalCategory = await this.categoriesRepository.findOne({
      where: { userId, name: 'Loan Principal', parentId: loanParent.id },
    });

    const interestCategory = await this.categoriesRepository.findOne({
      where: { userId, name: 'Loan Interest', parentId: loanParent.id },
    });

    return {
      principalCategory,
      interestCategory,
    };
  }

  /**
   * Import default categories for a user
   * Only works if user has no existing categories
   */
  async importDefaults(userId: string): Promise<{ categoriesCreated: number }> {
    // Check if user already has categories
    const existingCount = await this.categoriesRepository.count({
      where: { userId, isSystem: false },
    });

    if (existingCount > 0) {
      throw new BadRequestException(
        'Cannot import defaults: user already has categories. Delete existing categories first or start fresh.',
      );
    }

    // Income categories
    const incomeCategories = [
      { name: 'Salary', icon: '💰', color: '#2ECC71', isIncome: true },
      { name: 'Freelance', icon: '💼', color: '#1ABC9C', isIncome: true },
      { name: 'Investment Income', icon: '📈', color: '#3498DB', isIncome: true },
      { name: 'Other Income', icon: '💵', color: '#16A085', isIncome: true },
    ];

    // Expense categories with subcategories
    const expenseCategories = [
      {
        name: 'Housing',
        icon: '🏠',
        color: '#E74C3C',
        subcategories: ['Rent/Mortgage', 'Utilities', 'Property Tax', 'Maintenance'],
      },
      {
        name: 'Transportation',
        icon: '🚗',
        color: '#3498DB',
        subcategories: ['Fuel', 'Public Transit', 'Car Insurance', 'Maintenance'],
      },
      {
        name: 'Food',
        icon: '🍽️',
        color: '#E67E22',
        subcategories: ['Groceries', 'Restaurants', 'Coffee Shops'],
      },
      {
        name: 'Shopping',
        icon: '🛍️',
        color: '#9B59B6',
        subcategories: ['Clothing', 'Electronics', 'Home Goods'],
      },
      {
        name: 'Entertainment',
        icon: '🎬',
        color: '#F39C12',
        subcategories: ['Movies', 'Concerts', 'Streaming Services', 'Games'],
      },
      {
        name: 'Health',
        icon: '⚕️',
        color: '#27AE60',
        subcategories: ['Insurance', 'Doctor Visits', 'Pharmacy', 'Gym'],
      },
      {
        name: 'Education',
        icon: '📚',
        color: '#2980B9',
        subcategories: ['Tuition', 'Books', 'Courses'],
      },
      {
        name: 'Personal Care',
        icon: '💇',
        color: '#8E44AD',
        subcategories: ['Haircut', 'Cosmetics', 'Spa'],
      },
      {
        name: 'Bills & Utilities',
        icon: '📄',
        color: '#C0392B',
        subcategories: ['Phone', 'Internet', 'Electricity', 'Water', 'Insurance'],
      },
      { name: 'Gifts & Donations', icon: '🎁', color: '#E91E63', subcategories: [] },
      { name: 'Travel', icon: '✈️', color: '#00BCD4', subcategories: [] },
      { name: 'Miscellaneous', icon: '📌', color: '#95A5A6', subcategories: [] },
    ];

    let categoryCount = 0;

    // Create income categories
    for (const cat of incomeCategories) {
      const category = this.categoriesRepository.create({
        userId,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        isIncome: cat.isIncome,
      });
      await this.categoriesRepository.save(category);
      categoryCount++;
    }

    // Create expense categories with subcategories
    for (const cat of expenseCategories) {
      const parentCategory = this.categoriesRepository.create({
        userId,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        isIncome: false,
      });
      const savedParent = await this.categoriesRepository.save(parentCategory);
      categoryCount++;

      // Create subcategories
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
