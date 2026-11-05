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

export type WarrantyKind = 'manufacturer' | 'extended' | 'store' | 'other';

export interface CreatedWarranty {
  id: string;
  name: string;
  purchaseDate: string;
  expiresOn: string | null;
  isLifetime: boolean;
  status: string;
  transactionId?: string;
  archivedAt: string | null;
}

// A warranty takes exactly one of expiresOn, term or isLifetime; with none of
// them given it defaults to a two-year term from the purchase date, which the
// server reads as Active.
export function createWarranty(
  api: ApiClient,
  data: {
    name?: string;
    purchaseDate?: string;
    expiresOn?: string;
    term?: { years?: number; months?: number; days?: number };
    isLifetime?: boolean;
    vendorName?: string;
    transactionId?: string;
    purchasePrice?: number;
    currencyCode?: string;
    serialNumbers?: string[];
    warrantyKind?: WarrantyKind;
  } = {},
): Promise<CreatedWarranty> {
  const hasExpiry =
    data.expiresOn !== undefined || data.term !== undefined || data.isLifetime !== undefined;
  return api.post<CreatedWarranty>('/warranties', {
    name: data.name ?? `E2E Warranty ${uniqueId()}`,
    purchaseDate: data.purchaseDate ?? new Date().toISOString().slice(0, 10),
    ...(hasExpiry ? {} : { term: { years: 2 } }),
    ...(data.expiresOn !== undefined ? { expiresOn: data.expiresOn } : {}),
    ...(data.term !== undefined ? { term: data.term } : {}),
    ...(data.isLifetime !== undefined ? { isLifetime: data.isLifetime } : {}),
    ...(data.vendorName !== undefined ? { vendorName: data.vendorName } : {}),
    ...(data.transactionId !== undefined ? { transactionId: data.transactionId } : {}),
    ...(data.purchasePrice !== undefined
      ? { purchasePrice: data.purchasePrice, currencyCode: data.currencyCode ?? 'USD' }
      : {}),
    ...(data.serialNumbers !== undefined ? { serialNumbers: data.serialNumbers } : {}),
    ...(data.warrantyKind !== undefined ? { warrantyKind: data.warrantyKind } : {}),
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
  | 'CRYPTO'
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
    /** Link the row to a stored payee, as the payee detail page requires. */
    payeeId?: string;
    transactionDate?: string;
    currencyCode?: string;
    categoryId?: string;
    status?: string;
    /** A cheque or confirmation number, as the search's `ref:` field reads it. */
    referenceNumber?: string;
  },
): Promise<CreatedTransaction> {
  return api.post<CreatedTransaction>('/transactions', {
    accountId: data.accountId,
    amount: data.amount ?? -10,
    payeeName: data.payeeName ?? `E2E Txn ${uniqueId()}`,
    transactionDate: data.transactionDate ?? new Date().toISOString().slice(0, 10),
    currencyCode: data.currencyCode ?? 'USD',
    ...(data.payeeId !== undefined ? { payeeId: data.payeeId } : {}),
    ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.referenceNumber !== undefined ? { referenceNumber: data.referenceNumber } : {}),
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

// ---------------------------------------------------------------------------
// Phase 2 -- Wealth & analytics factories
// ---------------------------------------------------------------------------

export interface CreatedSecurity {
  id: string;
  symbol: string;
  name: string;
  securityType: string | null;
  currencyCode: string;
  isActive: boolean;
}

// Securities are per-user (the service scopes by userId), so a short unique
// symbol per fresh user never collides across the chromium/firefox projects.
export function createSecurity(
  api: ApiClient,
  data: {
    symbol?: string;
    name?: string;
    securityType?: string;
    exchange?: string;
    currencyCode?: string;
  } = {},
): Promise<CreatedSecurity> {
  return api.post<CreatedSecurity>('/securities', {
    symbol: data.symbol ?? `E${uniqueId().slice(-6).toUpperCase()}`,
    name: data.name ?? `E2E Security ${uniqueId()}`,
    securityType: data.securityType ?? 'STOCK',
    currencyCode: data.currencyCode ?? 'USD',
    ...(data.exchange !== undefined ? { exchange: data.exchange } : {}),
  });
}

export interface CreatedInvestmentPair {
  cashAccount: CreatedAccount;
  brokerageAccount: CreatedAccount;
}

// POST /accounts with accountType INVESTMENT + createInvestmentPair returns a
// linked { cashAccount, brokerageAccount } pair (see AccountsService.create).
// Investment transactions post against the brokerage account; the cash account
// funds buys / receives sells.
export function createInvestmentAccountPair(
  api: ApiClient,
  data: { name?: string; currencyCode?: string; openingBalance?: number } = {},
): Promise<CreatedInvestmentPair> {
  return api.post<CreatedInvestmentPair>('/accounts', {
    name: data.name ?? `E2E Brokerage ${uniqueId()}`,
    accountType: 'INVESTMENT',
    currencyCode: data.currencyCode ?? 'USD',
    openingBalance: data.openingBalance ?? 10000,
    createInvestmentPair: true,
  });
}

export type InvestmentAction =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'CAPITAL_GAIN'
  | 'SPLIT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'REINVEST'
  | 'ADD_SHARES'
  | 'REMOVE_SHARES'
  | 'RETURN_OF_CAPITAL';

export interface CreatedInvestmentTransaction {
  id: string;
  action: string;
  quantity: number;
  price: number;
}

// accountId must be an INVESTMENT (brokerage) account; BUY/SELL also require a
// securityId. fundingAccountId (the linked cash account) is optional.
export function createInvestmentTransaction(
  api: ApiClient,
  data: {
    accountId: string;
    securityId?: string;
    action?: InvestmentAction;
    quantity?: number;
    price?: number;
    commission?: number;
    fundingAccountId?: string;
    transactionDate?: string;
  },
): Promise<CreatedInvestmentTransaction> {
  return api.post<CreatedInvestmentTransaction>('/investment-transactions', {
    accountId: data.accountId,
    action: data.action ?? 'BUY',
    transactionDate:
      data.transactionDate ?? new Date().toISOString().slice(0, 10),
    ...(data.securityId !== undefined ? { securityId: data.securityId } : {}),
    ...(data.fundingAccountId !== undefined
      ? { fundingAccountId: data.fundingAccountId }
      : {}),
    quantity: data.quantity ?? 10,
    price: data.price ?? 100,
    ...(data.commission !== undefined ? { commission: data.commission } : {}),
  });
}

export interface CreatedSecurityPrice {
  id: number;
  priceDate: string;
  closePrice: number;
}

// A manual close for one day. The calendar's Daily change layer reads the
// closes dated a day to decide whether that day was a trading day at all, so a
// spec about it has to put the prices on the days it means -- a BUY alone leaves
// only its own transaction-derived close.
export function createSecurityPrice(
  api: ApiClient,
  securityId: string,
  data: { priceDate: string; closePrice: number },
): Promise<CreatedSecurityPrice> {
  return api.post<CreatedSecurityPrice>(`/securities/${securityId}/prices`, {
    priceDate: data.priceDate,
    closePrice: data.closePrice,
  });
}

export interface CreatedBudget {
  id: string;
  name: string;
  budgetType: string;
  strategy: string;
  currencyCode: string;
  periodStart: string;
}

// A budget needs name, periodStart, currencyCode. periodStart defaults to the
// first of the current month so the active period scopes to "now".
export function createBudget(
  api: ApiClient,
  data: {
    name?: string;
    periodStart?: string;
    currencyCode?: string;
    budgetType?: 'MONTHLY' | 'ANNUAL' | 'PAY_PERIOD';
    strategy?: 'FIXED' | 'ROLLOVER' | 'ZERO_BASED' | 'FIFTY_THIRTY_TWENTY';
    baseIncome?: number;
  } = {},
): Promise<CreatedBudget> {
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return api.post<CreatedBudget>('/budgets', {
    name: data.name ?? `E2E Budget ${uniqueId()}`,
    periodStart: data.periodStart ?? firstOfMonth,
    currencyCode: data.currencyCode ?? 'USD',
    budgetType: data.budgetType ?? 'MONTHLY',
    strategy: data.strategy ?? 'FIXED',
    ...(data.baseIncome !== undefined ? { baseIncome: data.baseIncome } : {}),
  });
}

export interface CreatedBudgetCategory {
  id: string;
  categoryId: string;
  amount: number;
}

export function addBudgetCategory(
  api: ApiClient,
  budgetId: string,
  data: { categoryId: string; amount?: number; isIncome?: boolean },
): Promise<CreatedBudgetCategory> {
  return api.post<CreatedBudgetCategory>(`/budgets/${budgetId}/categories`, {
    categoryId: data.categoryId,
    amount: data.amount ?? 500,
    ...(data.isIncome !== undefined ? { isIncome: data.isIncome } : {}),
  });
}

export interface CreatedDelegate {
  id: string;
  delegateUserId: string;
  email: string;
}

// The owner creates a delegate by email with an owner-set password (12+ chars,
// upper/lower/digit/special). The delegate becomes a delegate-only user. The
// caller supplies the password (a per-test value) so no credential is hardcoded
// here.
export function createDelegate(
  api: ApiClient,
  data: { email: string; password: string },
): Promise<CreatedDelegate> {
  return api.post<CreatedDelegate>('/delegation/delegates', {
    email: data.email,
    password: data.password,
  });
}

// Grant the delegate read access to a specific account, plus any of the
// per-operation write grants (create/edit/delete) the test needs. isJoint
// makes the account appear natively in the delegate's own context (requires
// the delegate to be a full account -- one that owns data of its own).
export function grantDelegateAccount(
  api: ApiClient,
  delegateId: string,
  accountId: string,
  flags: {
    canCreate?: boolean;
    canEdit?: boolean;
    canDelete?: boolean;
    isJoint?: boolean;
  } = {},
): Promise<void> {
  return api.put<void>(`/delegation/delegates/${delegateId}/grants`, {
    grants: [{ accountId, canRead: true, ...flags }],
  });
}

export interface CreatedCustomReport {
  id: string;
  name: string;
}

// Only `name` is required; every other field defaults server-side. The full
// report-builder form is deferred (see ROADMAP Phase 2.3) -- this seeds a
// report so the viewer/open path can be exercised.
export function createCustomReport(
  api: ApiClient,
  data: { name?: string } = {},
): Promise<CreatedCustomReport> {
  return api.post<CreatedCustomReport>('/reports/custom', {
    name: data.name ?? `E2E Report ${uniqueId()}`,
  });
}
