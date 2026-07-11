export type AccountType =
  | 'CHEQUING'
  | 'SAVINGS'
  | 'CREDIT_CARD'
  | 'LOAN'
  | 'MORTGAGE'
  | 'INVESTMENT'
  | 'CASH'
  | 'LINE_OF_CREDIT'
  | 'ASSET'
  | 'OTHER';

export type AccountSubType = 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE' | null;

export type PaymentFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export type MortgagePaymentFrequency =
  | 'MONTHLY'
  | 'SEMI_MONTHLY'
  | 'BIWEEKLY'
  | 'ACCELERATED_BIWEEKLY'
  | 'WEEKLY'
  | 'ACCELERATED_WEEKLY';

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
  institutionId: string | null;
  openingBalance: number;
  currentBalance: number;
  creditLimit: number | null;
  interestRate: number | null;
  isClosed: boolean;
  closedDate: string | null;
  isFavourite: boolean;
  favouriteSortOrder: number;
  excludeFromNetWorth: boolean;
  // Credit card statement fields
  statementDueDay: number | null;
  statementSettlementDay: number | null;
  // Loan-specific fields. Mortgages persist their (possibly accelerated or
  // semi-monthly) cadence in this same column, so the stored value may be a
  // MortgagePaymentFrequency, not only a loan PaymentFrequency.
  paymentAmount: number | null;
  paymentFrequency: PaymentFrequency | MortgagePaymentFrequency | null;
  paymentStartDate: string | null;
  sourceAccountId: string | null;
  principalCategoryId: string | null;
  interestCategoryId: string | null;
  // Category tagging standalone overpayments (extra principal) so the loan
  // schedule can flag them as 100% principal.
  overpaymentCategoryId: string | null;
  // Memo text marking a payment as a standalone overpayment (case-insensitive
  // substring match); usable with or instead of the overpayment category.
  overpaymentMemo: string | null;
  // Payee whose payments count as standalone overpayments (extra principal),
  // usable with or instead of the overpayment category / memo.
  overpaymentPayeeId: string | null;
  scheduledTransactionId: string | null;
  // Asset-specific fields
  assetCategoryId: string | null;
  dateAcquired: string | null;
  // Links an asset/other account to its financing loan/mortgage (equity view)
  linkedLoanAccountId: string | null;
  // Mortgage-specific fields
  isCanadianMortgage: boolean;
  isVariableRate: boolean;
  termMonths: number | null;
  termEndDate: string | null;
  amortizationMonths: number | null;
  originalPrincipal: number | null;
  canDelete?: boolean;
  futureTransactionsSum?: number;
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
  institutionId?: string | null;
  openingBalance?: number;
  creditLimit?: number;
  interestRate?: number;
  isFavourite?: boolean;
  excludeFromNetWorth?: boolean;
  createInvestmentPair?: boolean;
  // Credit card statement fields
  statementDueDay?: number;
  statementSettlementDay?: number;
  // Loan-specific fields
  paymentAmount?: number;
  paymentFrequency?: PaymentFrequency;
  paymentStartDate?: string;
  sourceAccountId?: string;
  principalCategoryId?: string;
  interestCategoryId?: string | null;
  overpaymentCategoryId?: string | null;
  overpaymentMemo?: string | null;
  overpaymentPayeeId?: string | null;
  // Asset-specific fields
  assetCategoryId?: string;
  dateAcquired?: string;
  linkedLoanAccountId?: string | null;
  // Mortgage-specific fields
  isCanadianMortgage?: boolean;
  isVariableRate?: boolean;
  termMonths?: number;
  amortizationMonths?: number;
  mortgagePaymentFrequency?: MortgagePaymentFrequency;
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

// Mortgage amortization types
export interface MortgagePreviewData {
  mortgageAmount: number;
  interestRate: number;
  amortizationMonths: number;
  paymentFrequency: MortgagePaymentFrequency;
  paymentStartDate: string;
  isCanadian: boolean;
  isVariableRate: boolean;
}

export interface MortgageAmortizationPreview {
  paymentAmount: number;
  principalPayment: number;
  interestPayment: number;
  totalPayments: number;
  endDate: string;
  totalInterest: number;
  effectiveAnnualRate: number;
}

export interface UpdateMortgageRateData {
  newRate: number;
  newPaymentAmount?: number;
  effectiveDate: string;
}

export interface UpdateMortgageRateResponse {
  newRate: number;
  paymentAmount: number;
  principalPayment: number;
  interestPayment: number;
  effectiveDate: string;
}

// Loan payment detection types
export interface DetectedLoanPayment {
  paymentAmount: number;
  paymentFrequency: string;
  confidence: number;
  sourceAccountId: string | null;
  sourceAccountName: string | null;
  interestCategoryId: string | null;
  interestCategoryName: string | null;
  principalCategoryId: string | null;
  estimatedInterestRate: number | null;
  suggestedNextDueDate: string;
  firstPaymentDate: string;
  lastPaymentDate: string;
  paymentCount: number;
  currentBalance: number;
  isMortgage: boolean;
  averageExtraPrincipal: number;
  extraPrincipalCount: number;
  lastPrincipalAmount: number | null;
  lastInterestAmount: number | null;
}

export interface SetupLoanPaymentsData {
  paymentAmount: number;
  paymentFrequency: string;
  sourceAccountId: string;
  nextDueDate: string;
  interestRate?: number;
  interestCategoryId?: string;
  payeeId?: string;
  payeeName?: string;
  autoPost?: boolean;
  isCanadianMortgage?: boolean;
  isVariableRate?: boolean;
  amortizationMonths?: number;
  termMonths?: number;
  extraPrincipal?: number;
  detectedInterestAmount?: number;
}

export interface SetupLoanPaymentsResponse {
  scheduledTransactionId: string;
  accountId: string;
  paymentAmount: number;
  paymentFrequency: string;
  nextDueDate: string;
}
