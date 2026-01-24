import { Category } from './category';

export interface Payee {
  id: string;
  userId: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategory: Category | null;
  notes: string | null;
  createdAt: string;
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
