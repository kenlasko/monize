import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../users/entities/user.entity';

@Injectable()
export class SeedService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async seedAll(): Promise<void> {
    console.log('🌱 Starting database seeding...\n');

    await this.seedCurrencies();
    const userId = await this.seedDemoUser();
    await this.seedCategories(userId);
    const accountIds = await this.seedAccounts(userId);
    await this.seedTransactions(userId, accountIds);

    console.log('\n✅ Database seeding completed successfully!');
  }

  private async seedCurrencies(): Promise<void> {
    console.log('💱 Seeding currencies...');

    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$' },
      { code: 'USD', name: 'US Dollar', symbol: '$' },
      { code: 'EUR', name: 'Euro', symbol: '€' },
      { code: 'GBP', name: 'British Pound', symbol: '£' },
      { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
      { code: 'AUD', name: 'Australian Dollar', symbol: '$' },
      { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr' },
      { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
      { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
      { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
    ];

    for (const currency of currencies) {
      await this.dataSource.query(
        `INSERT INTO currencies (code, name, symbol)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [currency.code, currency.name, currency.symbol],
      );
    }

    console.log(`   ✓ Seeded ${currencies.length} currencies`);
  }

  private async seedDemoUser(): Promise<string> {
    console.log('\n👤 Seeding demo user...');

    const email = 'demo@moneymate.com';
    const password = 'Demo123!';
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingUser = await this.dataSource.query(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );

    if (existingUser.length > 0) {
      console.log('   ✓ Demo user already exists');
      return existingUser[0].id;
    }

    const result = await this.dataSource.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, auth_provider, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [email, hashedPassword, 'Demo', 'User', 'local', true],
    );

    console.log(`   ✓ Created demo user: ${email} / ${password}`);
    return result[0].id;
  }

  private async seedCategories(userId: string): Promise<void> {
    console.log('\n📁 Seeding categories...');

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

    // Seed income categories
    for (const cat of incomeCategories) {
      await this.dataSource.query(
        `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, cat.name, cat.icon, cat.color, cat.isIncome],
      );
      categoryCount++;
    }

    // Seed expense categories with subcategories
    for (const cat of expenseCategories) {
      const parentResult = await this.dataSource.query(
        `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [userId, cat.name, cat.icon, cat.color, false],
      );
      categoryCount++;

      const parentId = parentResult[0].id;

      // Add subcategories
      for (const subName of cat.subcategories) {
        await this.dataSource.query(
          `INSERT INTO categories (user_id, parent_id, name, is_income)
           VALUES ($1, $2, $3, $4)`,
          [userId, parentId, subName, false],
        );
        categoryCount++;
      }
    }

    console.log(`   ✓ Seeded ${categoryCount} categories (including subcategories)`);
  }

  private async seedAccounts(userId: string): Promise<{ [key: string]: string }> {
    console.log('\n💳 Seeding accounts...');

    const accounts = [
      {
        type: 'CHEQUING',
        name: 'Primary Chequing',
        currency: 'CAD',
        balance: 5420.50,
        description: 'Main everyday banking account',
      },
      {
        type: 'SAVINGS',
        name: 'Emergency Fund',
        currency: 'CAD',
        balance: 15000.00,
        description: '6 months of expenses',
      },
      {
        type: 'CREDIT_CARD',
        name: 'Visa Rewards',
        currency: 'CAD',
        balance: -1250.75,
        creditLimit: 10000,
        interestRate: 19.99,
        description: 'Cashback credit card',
      },
      {
        type: 'RRSP',
        name: 'Retirement Savings',
        currency: 'CAD',
        balance: 42500.00,
        description: 'Long-term retirement investments',
      },
      {
        type: 'TFSA',
        name: 'Tax-Free Savings',
        currency: 'CAD',
        balance: 28750.00,
        description: 'Tax-free investment account',
      },
      {
        type: 'INVESTMENT',
        name: 'Stock Portfolio',
        currency: 'USD',
        balance: 12300.00,
        description: 'Individual stocks and ETFs',
      },
    ];

    const accountIds: { [key: string]: string } = {};

    for (const acc of accounts) {
      const result = await this.dataSource.query(
        `INSERT INTO accounts (
          user_id, account_type, name, description, currency_code,
          opening_balance, current_balance, credit_limit, interest_rate
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
        [
          userId,
          acc.type,
          acc.name,
          acc.description,
          acc.currency,
          acc.balance,
          acc.balance,
          acc.creditLimit || null,
          acc.interestRate || null,
        ],
      );
      accountIds[acc.type] = result[0].id;
    }

    console.log(`   ✓ Seeded ${accounts.length} accounts`);
    return accountIds;
  }

  private async seedTransactions(
    userId: string,
    accountIds: { [key: string]: string },
  ): Promise<void> {
    console.log('\n💸 Seeding transactions...');

    // Get category IDs
    const categories = await this.dataSource.query(
      'SELECT id, name FROM categories WHERE user_id = $1',
      [userId],
    );

    const getCategoryId = (name: string) => {
      const cat = categories.find((c) => c.name === name);
      return cat ? cat.id : null;
    };

    const transactions = [
      // Income transactions
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-15',
        payeeName: 'ABC Corporation',
        amount: 4500.00,
        description: 'Monthly salary',
        isCleared: true,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-20',
        payeeName: 'Freelance Client',
        amount: 1200.00,
        description: 'Website development project',
        isCleared: true,
      },

      // Expense transactions
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-03',
        payeeName: 'City Apartments',
        amount: -1800.00,
        description: 'January rent',
        isCleared: true,
        isReconciled: true,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-05',
        payeeName: 'Grocery Store',
        amount: -157.32,
        description: 'Weekly groceries',
        isCleared: true,
      },
      {
        accountId: accountIds.CREDIT_CARD,
        date: '2026-01-07',
        payeeName: 'Gas Station',
        amount: -65.00,
        description: 'Fuel',
        isCleared: false,
      },
      {
        accountId: accountIds.CREDIT_CARD,
        date: '2026-01-10',
        payeeName: 'Restaurant',
        amount: -87.50,
        description: 'Dinner with friends',
        isCleared: false,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-12',
        payeeName: 'Electric Company',
        amount: -125.00,
        description: 'Electricity bill',
        isCleared: true,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-14',
        payeeName: 'Internet Provider',
        amount: -79.99,
        description: 'Monthly internet',
        isCleared: true,
      },
      {
        accountId: accountIds.CREDIT_CARD,
        date: '2026-01-16',
        payeeName: 'Coffee Shop',
        amount: -5.75,
        description: 'Morning coffee',
        isCleared: false,
      },
      {
        accountId: accountIds.CREDIT_CARD,
        date: '2026-01-18',
        payeeName: 'Streaming Service',
        amount: -15.99,
        description: 'Netflix subscription',
        isCleared: false,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-19',
        payeeName: 'Pharmacy',
        amount: -42.30,
        description: 'Prescription medication',
        isCleared: true,
      },
      {
        accountId: accountIds.CHEQUING,
        date: '2026-01-21',
        payeeName: 'Transit Authority',
        amount: -100.00,
        description: 'Monthly transit pass',
        isCleared: true,
      },
      {
        accountId: accountIds.CREDIT_CARD,
        date: '2026-01-22',
        payeeName: 'Online Store',
        amount: -145.00,
        description: 'New headphones',
        isCleared: false,
      },
    ];

    for (const tx of transactions) {
      await this.dataSource.query(
        `INSERT INTO transactions (
          user_id, account_id, transaction_date, payee_name, amount,
          currency_code, description, is_cleared, is_reconciled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          tx.accountId,
          tx.date,
          tx.payeeName,
          tx.amount,
          'CAD',
          tx.description,
          tx.isCleared || false,
          tx.isReconciled || false,
        ],
      );
    }

    console.log(`   ✓ Seeded ${transactions.length} transactions`);
  }
}
