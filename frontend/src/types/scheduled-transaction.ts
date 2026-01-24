import { Account } from './account';
import { Payee } from './payee';
import { Category } from './category';

export type FrequencyType =
  | 'ONCE'
  | 'DAILY'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY';

export const FREQUENCY_LABELS: Record<FrequencyType, string> = {
  ONCE: 'One Time',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every 2 Weeks',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
};

export interface ScheduledTransactionSplit {
  id: string;
  scheduledTransactionId: string;
  categoryId: string | null;
  category: Category | null;
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
  splits?: ScheduledTransactionSplit[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionSplitData {
  categoryId?: string;
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
  splits?: CreateScheduledTransactionSplitData[];
}

export interface UpdateScheduledTransactionData extends Partial<CreateScheduledTransactionData> {}
