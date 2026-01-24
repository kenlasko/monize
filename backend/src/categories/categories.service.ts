import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionSplit } from '../transactions/entities/transaction-split.entity';
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

    await this.categoriesRepository.remove(category);
  }

  /**
   * Get the count of transactions using a category
   */
  async getTransactionCount(userId: string, categoryId: string): Promise<number> {
    await this.findOne(userId, categoryId);

    const transactionCount = await this.transactionsRepository.count({
      where: { userId, categoryId },
    });

    const splitCount = await this.splitsRepository.count({
      where: { categoryId },
    });

    return transactionCount + splitCount;
  }

  /**
   * Reassign transactions from one category to another
   */
  async reassignTransactions(
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{ transactionsUpdated: number; splitsUpdated: number }> {
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

    return {
      transactionsUpdated: transactionResult.affected || 0,
      splitsUpdated,
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
}
