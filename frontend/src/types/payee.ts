import { Category } from './category';

export interface Payee {
  id: string;
  userId: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategory: Category | null;
  notes: string | null;
  createdAt: string;
  transactionCount?: number;
}

export interface CreatePayeeData {
  name: string;
  defaultCategoryId?: string;
  notes?: string;
}

export interface UpdatePayeeData extends Partial<CreatePayeeData> {}

export interface PayeeSummary {
  totalPayees: number;
  payeesWithCategory: number;
  payeesWithoutCategory: number;
}

export interface CategorySuggestion {
  payeeId: string;
  payeeName: string;
  currentCategoryId: string | null;
  currentCategoryName: string | null;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  transactionCount: number;
  categoryCount: number;
  percentage: number;
}

export interface CategorySuggestionsParams {
  minTransactions: number;
  minPercentage: number;
  onlyWithoutCategory?: boolean;
}

export interface CategoryAssignment {
  payeeId: string;
  categoryId: string;
}
