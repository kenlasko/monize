import { Account } from './account';
import { Payee } from './payee';
import { Category } from './category';

export type FrequencyType =
  | 'ONCE'
  | 'DAILY'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY';

export const FREQUENCY_LABELS: Record<FrequencyType, string> = {
  ONCE: 'One Time',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every 2 Weeks',
  SEMIMONTHLY: 'Twice a Month',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
};

export interface ScheduledTransactionSplit {
  id: string;
  scheduledTransactionId: string;
  categoryId: string | null;
  category: Category | null;
  transferAccountId: string | null;
  transferAccount: Account | null;
  amount: number;
  memo: string | null;
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
  splits?: ScheduledTransactionSplit[];
  overrideCount?: number;
  nextOverride?: ScheduledTransactionOverride | null;
  futureOverrides?: ScheduledTransactionOverride[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionSplitData {
  categoryId?: string;
  transferAccountId?: string;
  amount: number;
  memo?: string;
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
  splits?: CreateScheduledTransactionSplitData[];
}

export interface UpdateScheduledTransactionData extends Partial<CreateScheduledTransactionData> {}

// ==================== Override Types ====================

export interface OverrideSplit {
  categoryId: string | null;
  transferAccountId?: string | null;
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
}

export interface UpdateScheduledTransactionOverrideData {
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  isSplit?: boolean | null;
  splits?: OverrideSplit[] | null;
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
}
