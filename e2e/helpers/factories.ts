import { ApiClient, uniqueId } from './api';

// Typed factories that seed data through the real backend API. Payload shapes
// mirror the frontend lib modules (e.g. frontend/src/lib/tags.ts). Each returns
// the created record (with id) so specs can reference it. New entities are
// added here as their specs are written.

export interface CreatedTag {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

export function createTag(
  api: ApiClient,
  data: { name?: string; color?: string; icon?: string } = {},
): Promise<CreatedTag> {
  return api.post<CreatedTag>('/tags', {
    name: data.name ?? `E2E Tag ${uniqueId()}`,
    ...(data.color !== undefined ? { color: data.color } : {}),
    ...(data.icon !== undefined ? { icon: data.icon } : {}),
  });
}

export interface CreatedCategory {
  id: string;
  name: string;
  isIncome: boolean;
  parentId: string | null;
}

export function createCategory(
  api: ApiClient,
  data: {
    name?: string;
    isIncome?: boolean;
    parentId?: string;
    description?: string;
  } = {},
): Promise<CreatedCategory> {
  return api.post<CreatedCategory>('/categories', {
    name: data.name ?? `E2E Category ${uniqueId()}`,
    isIncome: data.isIncome ?? false,
    ...(data.parentId !== undefined ? { parentId: data.parentId } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
  });
}

export interface CreatedPayee {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  notes: string | null;
}

export function createPayee(
  api: ApiClient,
  data: { name?: string; defaultCategoryId?: string; notes?: string } = {},
): Promise<CreatedPayee> {
  return api.post<CreatedPayee>('/payees', {
    name: data.name ?? `E2E Payee ${uniqueId()}`,
    ...(data.defaultCategoryId !== undefined
      ? { defaultCategoryId: data.defaultCategoryId }
      : {}),
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
  });
}

export type AccountType =
  | 'CHEQUING'
  | 'SAVINGS'
  | 'CREDIT_CARD'
  | 'CASH'
  | 'LINE_OF_CREDIT'
  | 'OTHER';

export interface CreatedAccount {
  id: string;
  name: string;
  accountType: string;
  currencyCode: string;
  currentBalance: number;
}

export function createAccount(
  api: ApiClient,
  data: {
    name?: string;
    accountType?: AccountType;
    currencyCode?: string;
    openingBalance?: number;
  } = {},
): Promise<CreatedAccount> {
  // A fresh user's default currency is USD (user_preference default).
  return api.post<CreatedAccount>('/accounts', {
    name: data.name ?? `E2E Account ${uniqueId()}`,
    accountType: data.accountType ?? 'CHEQUING',
    currencyCode: data.currencyCode ?? 'USD',
    openingBalance: data.openingBalance ?? 0,
  });
}

export interface CreatedTransaction {
  id: string;
  amount: number;
  payeeName: string | null;
  transactionDate: string;
}

export function createTransaction(
  api: ApiClient,
  data: {
    accountId: string;
    amount?: number;
    payeeName?: string;
    transactionDate?: string;
    currencyCode?: string;
    categoryId?: string;
    status?: string;
  },
): Promise<CreatedTransaction> {
  return api.post<CreatedTransaction>('/transactions', {
    accountId: data.accountId,
    amount: data.amount ?? -10,
    payeeName: data.payeeName ?? `E2E Txn ${uniqueId()}`,
    transactionDate: data.transactionDate ?? new Date().toISOString().slice(0, 10),
    currencyCode: data.currencyCode ?? 'USD',
    ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  });
}

export interface CreatedScheduledTransaction {
  id: string;
  name: string;
  amount: number;
  frequency: string;
}

export function createScheduledTransaction(
  api: ApiClient,
  data: {
    accountId: string;
    name?: string;
    amount?: number;
    frequency?: string;
    nextDueDate?: string;
    currencyCode?: string;
  },
): Promise<CreatedScheduledTransaction> {
  return api.post<CreatedScheduledTransaction>('/scheduled-transactions', {
    accountId: data.accountId,
    name: data.name ?? `E2E Schedule ${uniqueId()}`,
    amount: data.amount ?? -100,
    currencyCode: data.currencyCode ?? 'USD',
    frequency: data.frequency ?? 'MONTHLY',
    nextDueDate: data.nextDueDate ?? new Date().toISOString().slice(0, 10),
  });
}

export interface CreatedCurrency {
  code: string;
  name: string;
  symbol: string;
}

// Currencies are a global catalog keyed by a 3-char code (the create DTO only
// enforces length, not ISO validity). Tests pass distinct fake codes (e.g.
// "ZQA") that won't collide with the seeded real currencies.
export function createCurrency(
  api: ApiClient,
  data: { code: string; name?: string; symbol?: string; decimalPlaces?: number },
): Promise<CreatedCurrency> {
  return api.post<CreatedCurrency>('/currencies', {
    code: data.code,
    name: data.name ?? `E2E Currency ${data.code}`,
    symbol: data.symbol ?? data.code.slice(0, 2),
    decimalPlaces: data.decimalPlaces ?? 2,
  });
}
