import { Account } from './account';
import { Payee } from './payee';
import { Category } from './category';
import { Tag } from './tag';
import { InvestmentAction, Security } from './investment';
import { SplitKind, InvestmentSplitDetails } from './transaction';

export type FrequencyType =
  | 'ONCE'
  | 'DAILY'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'EVERY4WEEKS'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY';

export const FREQUENCY_LABELS: Record<FrequencyType, string> = {
  ONCE: 'One Time',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every 2 Weeks',
  EVERY4WEEKS: 'Every 4 Weeks',
  SEMIMONTHLY: 'Twice a Month',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
};

export interface ScheduledTransactionSplit {
  id: string;
  scheduledTransactionId: string;
  kind?: SplitKind;
  categoryId: string | null;
  category: Category | null;
  transferAccountId: string | null;
  transferAccount: Account | null;
  amount: number;
  memo: string | null;
  tags?: Tag[];
  // Investment-split fields
  investmentAction?: InvestmentAction | null;
  investmentSecurityId?: string | null;
  investmentSecurity?: Security | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentCommission?: number | null;
  investmentExchangeRate?: number | null;
  createdAt: string;
}

export interface ScheduledTransaction {
  id: string;
  userId: string;
  accountId: string;
  account: Account | null;
  name: string;
  payeeId: string | null;
  payee: Payee | null;
  payeeName: string | null;
  categoryId: string | null;
  category: Category | null;
  amount: number;
  currencyCode: string;
  description: string | null;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate: string;
  endDate: string | null;
  occurrencesRemaining: number | null;
  totalOccurrences: number | null;
  isActive: boolean;
  autoPost: boolean;
  reminderDaysBefore: number;
  lastPostedDate: string | null;
  isSplit: boolean;
  isTransfer: boolean;
  transferAccountId: string | null;
  transferAccount: Account | null;
  isInvestment: boolean;
  investmentAction: InvestmentAction | null;
  investmentSecurityId: string | null;
  investmentSecurity: Security | null;
  investmentFundingAccountId: string | null;
  investmentFundingAccount: Account | null;
  investmentQuantity: number | null;
  investmentPrice: number | null;
  investmentCommission: number | null;
  investmentTotalAmount: number | null;
  investmentExchangeRate: number | null;
  tagIds?: string[];
  splits?: ScheduledTransactionSplit[];
  overrideCount?: number;
  nextOverride?: ScheduledTransactionOverride | null;
  futureOverrides?: ScheduledTransactionOverride[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionSplitData {
  splitKind?: SplitKind;
  categoryId?: string;
  transferAccountId?: string;
  investment?: InvestmentSplitDetails;
  amount: number;
  memo?: string;
  tagIds?: string[];
}

export interface CreateScheduledTransactionData {
  accountId: string;
  name: string;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  amount: number;
  currencyCode: string;
  description?: string;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate?: string;
  endDate?: string;
  occurrencesRemaining?: number;
  isActive?: boolean;
  autoPost?: boolean;
  reminderDaysBefore?: number;
  isTransfer?: boolean;
  transferAccountId?: string;
  isInvestment?: boolean;
  investmentAction?: InvestmentAction;
  investmentSecurityId?: string;
  investmentFundingAccountId?: string;
  investmentQuantity?: number;
  investmentPrice?: number;
  investmentCommission?: number;
  investmentTotalAmount?: number;
  investmentExchangeRate?: number;
  splits?: CreateScheduledTransactionSplitData[];
  tagIds?: string[];
}

export interface UpdateScheduledTransactionData extends Partial<CreateScheduledTransactionData> {}

// ==================== Override Types ====================

export interface OverrideSplit {
  splitKind?: SplitKind;
  categoryId: string | null;
  transferAccountId?: string | null;
  investment?: InvestmentSplitDetails;
  amount: number;
  memo?: string | null;
}

export interface ScheduledTransactionOverride {
  id: string;
  scheduledTransactionId: string;
  originalDate: string; // The original calculated occurrence date this override replaces
  overrideDate: string; // The actual date for this occurrence (may differ if date was changed)
  amount: number | null;
  categoryId: string | null;
  category?: Category | null;
  description: string | null;
  isSplit: boolean | null;
  splits: OverrideSplit[] | null;
  investmentQuantity: number | null;
  investmentPrice: number | null;
  investmentTotalAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionOverrideData {
  originalDate: string; // The original calculated occurrence date being overridden
  overrideDate: string; // The actual date for this occurrence
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  isSplit?: boolean | null;
  splits?: OverrideSplit[] | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentTotalAmount?: number | null;
}

export interface UpdateScheduledTransactionOverrideData {
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  isSplit?: boolean | null;
  splits?: OverrideSplit[] | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentTotalAmount?: number | null;
}

export interface OverrideCheckResult {
  hasOverrides: boolean;
  count: number;
}

export interface PostScheduledTransactionData {
  transactionDate?: string;
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  referenceNumber?: string;
  isSplit?: boolean;
  splits?: OverrideSplit[];
  investmentQuantity?: number;
  investmentPrice?: number;
  investmentTotalAmount?: number;
}
