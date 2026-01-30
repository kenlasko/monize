export type AccountType =
  | 'CHEQUING'
  | 'SAVINGS'
  | 'CREDIT_CARD'
  | 'LOAN'
  | 'MORTGAGE'
  | 'RRSP'
  | 'TFSA'
  | 'RESP'
  | 'INVESTMENT'
  | 'CASH'
  | 'LINE_OF_CREDIT'
  | 'ASSET'
  | 'OTHER';

export type AccountSubType = 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE' | null;

export type PaymentFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface Account {
  id: string;
  userId: string;
  accountType: AccountType;
  accountSubType: AccountSubType;
  linkedAccountId: string | null;
  name: string;
  description: string | null;
  currencyCode: string;
  accountNumber: string | null;
  institution: string | null;
  openingBalance: number;
  currentBalance: number;
  creditLimit: number | null;
  interestRate: number | null;
  isClosed: boolean;
  closedDate: string | null;
  isFavourite: boolean;
  // Loan-specific fields
  paymentAmount: number | null;
  paymentFrequency: PaymentFrequency | null;
  paymentStartDate: string | null;
  sourceAccountId: string | null;
  principalCategoryId: string | null;
  interestCategoryId: string | null;
  scheduledTransactionId: string | null;
  // Asset-specific fields
  assetCategoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountData {
  accountType: AccountType;
  name: string;
  description?: string;
  currencyCode: string;
  accountNumber?: string;
  institution?: string;
  openingBalance?: number;
  creditLimit?: number;
  interestRate?: number;
  isFavourite?: boolean;
  createInvestmentPair?: boolean;
  // Loan-specific fields
  paymentAmount?: number;
  paymentFrequency?: PaymentFrequency;
  paymentStartDate?: string;
  sourceAccountId?: string;
  principalCategoryId?: string;
  interestCategoryId?: string;
  // Asset-specific fields
  assetCategoryId?: string;
}

export interface InvestmentAccountPair {
  cashAccount: Account;
  brokerageAccount: Account;
}

export interface UpdateAccountData extends Partial<CreateAccountData> {}

export interface AccountSummary {
  totalAccounts: number;
  totalBalance: number;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

// Loan amortization types
export interface LoanPreviewData {
  loanAmount: number;
  interestRate: number;
  paymentAmount: number;
  paymentFrequency: PaymentFrequency;
  paymentStartDate: string;
}

export interface AmortizationPreview {
  principalPayment: number;
  interestPayment: number;
  remainingBalance: number;
  totalPayments: number;
  endDate: string;
}
