import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

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
    firstName: 'Test',
    lastName: 'User',
    passwordHash: '',
    authProvider: 'local',
    role: 'user',
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
    accountType: 'CHEQUING',
    currencyCode: 'USD',
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
    transactionDate: '2026-01-15',
    amount: -50.0,
    currencyCode: 'USD',
    exchangeRate: 1,
    description: 'Test transaction',
    status: 'UNRECONCILED',
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
    type: 'expense',
    icon: 'tag',
    color: '#3b82f6',
    ...overrides,
  };
}

export async function createTestUser(
  repo: Repository<any>,
  overrides: Partial<UserData> = {},
): Promise<any> {
  const passwordHash = await bcrypt.hash('TestPassword123!', 10);
  const userData = buildUser({ passwordHash, ...overrides });
  const user = repo.create(userData);
  return repo.save(user);
}
