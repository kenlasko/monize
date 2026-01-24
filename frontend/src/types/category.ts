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
  isIncome: boolean;
  isSystem: boolean;
  createdAt: string;
}

export interface CreateCategoryData {
  name: string;
  parentId?: string;
  description?: string;
  icon?: string;
  color?: string;
  isIncome?: boolean;
}

export interface UpdateCategoryData extends Partial<CreateCategoryData> {}
