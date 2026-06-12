export interface Category {
  id: string;
  userId: string;
  parentId: string | null;
  parent: Category | null;
  children: Category[];
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  effectiveColor: string | null;
  isIncome: boolean;
  isSystem: boolean;
  isTaxRelated?: boolean;
  taxLineItem?: string | null;
  createdAt: string;
  transactionCount?: number;
}

export interface CreateCategoryData {
  name: string;
  parentId?: string;
  description?: string;
  icon?: string;
  color?: string;
  isIncome?: boolean;
  isTaxRelated?: boolean;
  taxLineItem?: string | null;
}

export interface UpdateCategoryData extends Partial<CreateCategoryData> {}
