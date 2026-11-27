import * as bcrypt from "bcryptjs";
import { DataSource, Repository } from "typeorm";
import { Account } from "@/accounts/entities/account.entity";
import { Category } from "@/categories/entities/category.entity";
import {
  CategoryType,
  categoryTypeFromIncomeFlag,
} from "@/categories/category-type.util";
import { Payee } from "@/payees/entities/payee.entity";

interface UserData {
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
  authProvider: string;
  role: string;
  isActive: boolean;
}

interface AccountData {
  userId: string;
  name: string;
  accountType: string;
  currencyCode: string;
  openingBalance: number;
  currentBalance: number;
  isClosed: boolean;
}

interface TransactionData {
  userId: string;
  accountId: string;
  transactionDate: string;
  amount: number;
  currencyCode: string;
  exchangeRate: number;
  description: string;
  status: string;
}

interface CategoryData {
  userId: string;
  name: string;
  type: string;
  icon: string;
  color: string;
}

export function buildUser(overrides: Partial<UserData> = {}): UserData {
  return {
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    firstName: "Test",
    lastName: "User",
    passwordHash: "",
    authProvider: "local",
    role: "user",
    isActive: true,
    ...overrides,
  };
}

export function buildAccount(
  userId: string,
  overrides: Partial<AccountData> = {},
): AccountData {
  return {
    userId,
    name: `Test Account ${Date.now()}`,
    accountType: "CHEQUING",
    currencyCode: "USD",
    openingBalance: 0,
    currentBalance: 0,
    isClosed: false,
    ...overrides,
  };
}

export function buildTransaction(
  userId: string,
  accountId: string,
  overrides: Partial<TransactionData> = {},
): TransactionData {
  return {
    userId,
    accountId,
    transactionDate: "2026-01-15",
    amount: -50.0,
    currencyCode: "USD",
    exchangeRate: 1,
    description: "Test transaction",
    status: "UNRECONCILED",
    ...overrides,
  };
}

export function buildCategory(
  userId: string,
  overrides: Partial<CategoryData> = {},
): CategoryData {
  return {
    userId,
    name: `Test Category ${Date.now()}`,
    type: "expense",
    icon: "tag",
    color: "#3b82f6",
    ...overrides,
  };
}

export async function createTestUser(
  repo: Repository<any>,
  overrides: Partial<UserData> = {},
): Promise<any> {
  const passwordHash = await bcrypt.hash("TestPassword123!", 10);
  const userData = buildUser({ passwordHash, ...overrides });
  const user = repo.create(userData);
  return repo.save(user);
}

/**
 * Database-persisting factory functions for integration tests.
 * These bypass service logic and insert directly via DataSource.
 */

export async function createTestAccount(
  dataSource: DataSource,
  userId: string,
  overrides: Partial<AccountData> = {},
): Promise<Account> {
  const data = buildAccount(userId, overrides);
  const account = dataSource.manager.create(Account, data as any);
  return dataSource.manager.save(account);
}

export async function createTestCategory(
  dataSource: DataSource,
  userId: string,
  overrides: Partial<
    CategoryData & {
      categoryType: CategoryType;
      /** Shorthand for `categoryType`: true is Income, false is Expense. */
      isIncome: boolean;
      parentId: string;
    }
  > = {},
): Promise<Category> {
  const { categoryType, isIncome, parentId, ...rest } = overrides;
  const data = buildCategory(userId, rest);
  const category = dataSource.manager.create(Category, {
    ...data,
    categoryType: categoryType ?? categoryTypeFromIncomeFlag(isIncome),
    parentId: parentId ?? null,
  } as any);
  return dataSource.manager.save(category);
}

export async function createTestPayee(
  dataSource: DataSource,
  userId: string,
  overrides: Partial<{
    name: string;
    defaultCategoryId: string;
    notes: string;
    isActive: boolean;
  }> = {},
): Promise<Payee> {
  const data: Record<string, any> = {
    userId,
    name: overrides.name || `Test Payee ${Date.now()}`,
    isActive: overrides.isActive ?? true,
  };
  if (overrides.defaultCategoryId) {
    data.defaultCategoryId = overrides.defaultCategoryId;
  }
  if (overrides.notes) {
    data.notes = overrides.notes;
  }
  const payee = dataSource.manager.create(Payee, data);
  return dataSource.manager.save(payee);
}
