import { Category } from './category';

export interface Payee {
  id: string;
  userId: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategory: Category | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  transactionCount?: number;
  lastUsedDate?: string | null;
  aliasCount?: number;
  uncategorizedCount?: number;
}

export interface PayeeAlias {
  id: string;
  payeeId: string;
  userId: string;
  alias: string;
  createdAt: string;
  payee?: Payee;
}

export interface CreatePayeeData {
  name: string;
  defaultCategoryId?: string;
  notes?: string;
}

export interface UpdatePayeeData extends Partial<CreatePayeeData> {
  isActive?: boolean;
}

export interface CreatePayeeAliasData {
  payeeId: string;
  alias: string;
}

export interface MergePayeeData {
  targetPayeeId: string;
  sourcePayeeId: string;
  addAsAlias?: boolean;
}

export interface MergePayeeResult {
  transactionsMigrated: number;
  aliasAdded: boolean;
  sourcePayeeDeleted: boolean;
}

export type CategoryMatchMode = 'off' | 'category' | 'subcategory';

export interface AutoMergePreviewParams {
  minGroupSize: number;
  similarityThreshold: number;
  minTokenLength: number;
  includeInactive: boolean;
  categoryMatch: CategoryMatchMode;
  ignoreCommonWords: boolean;
  commonWordMinVariants: number;
}

export interface AutoMergeMember {
  payeeId: string;
  name: string;
  transactionCount: number;
  isCanonical: boolean;
}

export interface AutoMergeGroup {
  groupKey: string;
  suggestedCanonicalPayeeId: string;
  suggestedName: string;
  suggestedAlias: string;
  suggestedCategoryId: string | null;
  uncategorizedTransactionCount: number;
  members: AutoMergeMember[];
  totalTransactions: number;
}

export interface ApplyAutoMergeGroup {
  canonicalPayeeId: string;
  canonicalName?: string;
  sourcePayeeIds: string[];
  alias?: string;
  defaultCategoryId?: string;
  backfillTransactions?: boolean;
}

export interface ApplyAutoMergeResult {
  groupsMerged: number;
  payeesMerged: number;
  transactionsMigrated: number;
  aliasesCreated: number;
  skippedAliases: number;
  transactionsBackfilled: number;
}

export interface PayeeSummary {
  totalPayees: number;
  payeesWithCategory: number;
  payeesWithoutCategory: number;
  activePayees: number;
  inactivePayees: number;
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
  uncategorizedCount: number;
}

export interface CategorySuggestionsParams {
  minTransactions: number;
  minPercentage: number;
  onlyWithoutCategory?: boolean;
}

export interface CategoryAssignment {
  payeeId: string;
  categoryId: string;
  backfillTransactions?: boolean;
}

export interface DeactivationPreviewParams {
  maxTransactions: number;
  monthsUnused: number;
}

export interface DeactivationCandidate {
  payeeId: string;
  payeeName: string;
  transactionCount: number;
  lastUsedDate: string | null;
  defaultCategoryName: string | null;
}

export type PayeeStatusFilter = 'active' | 'inactive' | 'all';
