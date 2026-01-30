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

    // Income categories with subcategories
    const incomeCategories = [
      {
        name: 'Investment Income',
        subcategories: ['Capital Gains', 'Interest', 'RESP Grant'],
      },
      {
        name: 'Other Income',
        subcategories: [
          'Blogging',
          'Business Reimbursement',
          'Cashback',
          'Consulting',
          'Credit Card Reward',
          'Employee Stock Option',
          'Gifts Received',
          'Income Tax Refund',
          'Rental Income',
          'State & Local Tax Refund',
          'Transfer Bonus',
          'Tutoring',
        ],
      },
      {
        name: 'Retirement Income',
        subcategories: ['CPP/QPP Benefits'],
      },
      {
        name: 'Wages & Salary',
        subcategories: [
          'Bonus',
          'Commission',
          'Employer Matching',
          'Gross Pay',
          'Net Pay',
          'Overtime',
          'Vacation Pay',
        ],
      },
    ];

    // Expense categories with subcategories
    const expenseCategories = [
      {
        name: 'Automobile',
        subcategories: [
          'Accessories',
          'Car Payment',
          'Cleaning',
          'Fines',
          'Gasoline',
          'Licencing',
          'Maintenance',
          'Parking',
          'Parts',
          'Toll Charges',
        ],
      },
      {
        name: 'Bank Fees',
        subcategories: ['ATM', 'Annual', 'NSF', 'Other', 'Overdraft', 'Service'],
      },
      {
        name: 'Bills',
        subcategories: [
          'Accounting',
          'Cable TV',
          'Cell Phone',
          'Electricity',
          'Internet',
          'Lawyer',
          'Natural Gas',
          'Satellite Radio',
          'Streaming',
          'Telephone',
          'Water & Sewer',
          'Water Heater',
        ],
      },
      {
        name: 'Business',
        subcategories: [
          'Airfare',
          'Alcohol',
          'Bank Fees',
          'Car Rental',
          'Cell Phone',
          'Computer Hardware',
          'Computer Software',
          'Dining Out',
          'Education',
          'Gasoline',
          'Internet',
          'Lodging',
          'Mileage',
          'Miscellaneous',
          'Parking',
          'Recreation',
          'Toll Charges',
          'Transit',
        ],
      },
      {
        name: 'Cash Withdrawal',
        subcategories: [
          'Barbadian Dollars',
          'Bermudian Dollars',
          'Canadian Dollars',
          'Costa Rican Colones',
          'Croatian Kunas',
          'Dominican Republic Pesos',
          'Eastern Caribbean Dollars',
          'Euros',
          'Forints',
          'Honduran Lempiras',
          'Hong Kong Dollars',
          'Indonesian Rupiah',
          'Malaysian Ringgits',
          'Mexican Pesos',
          'Peruvian Soles',
          'Singapore Dollars',
          'Thai Baht',
          'US Dollars',
        ],
      },
      { name: 'Charitable Donations', subcategories: [] },
      {
        name: 'Childcare',
        subcategories: [
          'Activities',
          'Allowance',
          'Babysitting',
          'Books',
          'Clothing',
          'Counselling',
          'Daycare',
          'Entertainment',
          'Fees',
          'Furnishings',
          'Gifts',
          'Haircut',
          'Medication',
          'Shoes',
          'Sporting Goods',
          'Sports',
          'Supplies',
          'Toiletries',
          'Toys & Games',
        ],
      },
      {
        name: 'Clothing',
        subcategories: ['Accessories', 'Clothes', 'Coats', 'Shoes'],
      },
      {
        name: 'Computer',
        subcategories: ['Hardware', 'Software', 'Web Hosting'],
      },
      {
        name: 'Education',
        subcategories: ['Books', 'Fees', 'Tuition'],
      },
      {
        name: 'Food',
        subcategories: ['Alcohol', 'Cannabis', 'Dining Out', 'Groceries'],
      },
      {
        name: 'Furnishings',
        subcategories: [
          'Accessories',
          'Appliances',
          'Basement',
          'Bathroom',
          'Bedroom',
          'Dining Room',
          'Dishes',
          'Kitchen',
          'Living Room',
          'Office',
          'Outdoor',
          'Plants',
        ],
      },
      {
        name: 'Gifts',
        subcategories: [
          'Anniversary',
          'Birthday',
          'Cards',
          'Christmas',
          'Flowers',
          "Mother's Day",
          'RESP Contribution',
          'Valentines',
          'Wedding',
        ],
      },
      {
        name: 'Healthcare',
        subcategories: [
          'Counselling',
          'Dental',
          'Eyecare',
          'Fertility',
          'Fitness',
          'Hospital',
          'Massage',
          'Medication',
          'Physician',
          'Physiotherapy',
          'Prescriptions',
          'Supplies',
        ],
      },
      {
        name: 'Housing',
        subcategories: [
          'Fees',
          'Garden Supplies',
          'Home Improvement',
          'Maintenance',
          'Mortgage Interest',
          'Mortgage Principal',
          'Rent',
          'Supplies',
          'Tools',
        ],
      },
      {
        name: 'Insurance',
        subcategories: [
          'Automobile',
          'Disability',
          'Health',
          'Homeowner/Renter',
          'Life',
          'Travel',
        ],
      },
      { name: 'Interest Expense', subcategories: [] },
      {
        name: 'Leisure',
        subcategories: [
          'Books & Magazines',
          'CD',
          'Camera/Film',
          'Camping',
          'Cover Charge',
          'Cultural Events',
          'DVD',
          'Electronics',
          'Entertaining',
          'Entertainment',
          'Fees',
          'Gambling',
          'LPs',
          'Movies',
          'Newspaper',
          'Sporting Events',
          'Sporting Goods',
          'Sports',
          'Toys & Games',
          'Transit',
          'VHS',
          'Video Rentals',
        ],
      },
      { name: 'Licencing Fees', subcategories: [] },
      {
        name: 'Loan',
        subcategories: ['Loan Interest', 'Loan Principal', 'Mortgage Interest'],
      },
      {
        name: 'Miscellaneous',
        subcategories: ['Postage', 'Postcards', 'Tools', 'Transit'],
      },
      {
        name: 'Personal Care',
        subcategories: [
          'Dry Cleaning',
          'Haircut',
          'Laundry',
          'Pedicure',
          'Toiletries',
        ],
      },
      {
        name: 'Pet Care',
        subcategories: ['Food', 'Supplies', 'Veterinarian'],
      },
      {
        name: 'Taxes',
        subcategories: [
          'CPP/QPP Contributions',
          'EI Premiums',
          'Federal Income',
          'Goods & Services',
          'Other',
          'Property',
          'Real Estate',
          'State/Provincial',
          'Union Dues',
        ],
      },
      {
        name: 'Vacation',
        subcategories: [
          'Airfare',
          'Car Rental',
          'Entertainment',
          'Gasoline',
          'Lodging',
          'Miscellaneous',
          'Parking',
          'Transit',
          'Travel',
        ],
      },
    ];

    let categoryCount = 0;

    // Create income categories with subcategories
    for (const cat of incomeCategories) {
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

    // Create expense categories with subcategories
    for (const cat of expenseCategories) {
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
