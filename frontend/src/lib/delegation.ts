import apiClient from './api';
import type { CategoryType } from '@/lib/category-type';
import { Category } from '@/types/category';

export interface DelegateContext {
  userId: string;
  label: string;
  isSelf: boolean;
  ownerHas2FA: boolean;
}

export interface ResourceCapabilities {
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface DelegateCapabilityFlags {
  payees: ResourceCapabilities;
  categories: ResourceCapabilities;
  tags: ResourceCapabilities;
}

export interface ContextsResponse {
  actingAsUserId: string | null;
  contexts: DelegateContext[];
  capabilities: DelegateCapabilityFlags | null;
  sections: DelegateSectionGrants | null;
}

export interface AccountGrant {
  accountId: string;
  canRead: boolean;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  /**
   * Joint account opt-in: with canRead, the account appears natively in the
   * delegate's own context. Must round-trip through the grant editor -- the
   * save path is delete-and-recreate, so omitting it clears the flag.
   */
  isJoint?: boolean;
}

/** Owner-grantable READ sections (gate tab visibility + section endpoints). */
export interface DelegateSectionGrants {
  bills: boolean;
  investments: boolean;
  budgets: boolean;
  reports: boolean;
  ai: boolean;
  warranties: boolean;
  /**
   * Derived (not a stored section): true when the delegate can read any
   * non-investment account, so the Transactions section/nav is reachable.
   * Optional because the owner-facing delegate summary omits it.
   */
  transactions?: boolean;
  /**
   * Derived (not a stored section): true when the delegate can read any
   * account at all, so the Accounts section/nav is reachable.
   * Optional because the owner-facing delegate summary omits it.
   */
  accounts?: boolean;
}

/** Column-shaped partial used by the PUT /sections endpoint. */
export interface DelegateSectionFlags {
  billsCanRead?: boolean;
  investmentsCanRead?: boolean;
  budgetsCanRead?: boolean;
  reportsCanRead?: boolean;
  aiCanRead?: boolean;
  warrantiesCanRead?: boolean;
}

/** Owner reference data served for a joint account's transaction form. */
export interface JointReferenceData {
  categories: Array<{
    id: string;
    name: string;
    parentId: string | null;
    icon: string | null;
    color: string | null;
    categoryType?: CategoryType;
    /** Read-only, derived; read the type through `@/lib/category-type`. */
    isIncome: boolean;
    isSystem: boolean;
  }>;
  payees: Array<{
    id: string;
    name: string;
    defaultCategoryId: string | null;
  }>;
  payeesCanCreate: boolean;
  categoriesCanCreate: boolean;
}

export interface DelegateSummary {
  id: string;
  status: string;
  createdAt: string;
  delegate: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    hasPassword: boolean;
    // False when the delegate's password is their own (they have their own
    // Monize account, or are a delegate for another owner too); the owner
    // cannot reset it in that case.
    canResetPassword: boolean;
    // True when the delegate is a full Monize account in their own right;
    // gates the Joint toggle (joint shares require a real account).
    isFullAccount?: boolean;
  };
  grants: AccountGrant[];
  capabilities: DelegateCapabilityFlags;
  sections?: DelegateSectionGrants;
}

export interface DelegateCapabilities {
  payeesCanCreate?: boolean;
  payeesCanEdit?: boolean;
  payeesCanDelete?: boolean;
  categoriesCanCreate?: boolean;
  categoriesCanEdit?: boolean;
  categoriesCanDelete?: boolean;
  tagsCanCreate?: boolean;
  tagsCanEdit?: boolean;
  tagsCanDelete?: boolean;
}

export interface CreateDelegatePayload {
  email: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  sendInvite?: boolean;
}

export interface CreateDelegateResponse {
  id: string;
  delegateUserId: string;
  email: string;
  temporaryPassword?: string;
  invited: boolean;
}

export const delegationApi = {
  getContexts: async (): Promise<ContextsResponse> => {
    const res = await apiClient.get<ContextsResponse>('/auth/contexts');
    return res.data;
  },

  switchContext: async (
    targetUserId: string,
  ): Promise<{ actingAsUserId: string | null }> => {
    const res = await apiClient.post('/auth/switch-context', { targetUserId });
    return res.data;
  },

  // The owner's category/payee pickers for a joint account's register,
  // gated server-side on the caller's joint READ grant. A joint row belongs
  // to the owner, so it may only carry the owner's reference ids.
  getJointReferenceData: async (
    accountId: string,
  ): Promise<JointReferenceData> => {
    const res = await apiClient.get<JointReferenceData>(
      `/delegation/joint-accounts/${accountId}/reference-data`,
    );
    return res.data;
  },

  /**
   * Create a category on the ledger of the owner who shares `accountId`
   * jointly with the caller, gated server-side on the delegation's
   * categories-can-create capability (the same flag `getJointReferenceData`
   * reports). A joint row may only carry the OWNER's category ids, so
   * `categoriesApi.create` -- which writes to the caller's own ledger -- is
   * the wrong door here, and there was no other until this endpoint existed.
   */
  createJointCategory: async (
    accountId: string,
    data: { name: string; parentId?: string; type?: CategoryType },
  ): Promise<Category> => {
    const res = await apiClient.post<Category>(
      `/categories/joint/${accountId}`,
      data,
    );
    return res.data;
  },

  listDelegates: async (): Promise<DelegateSummary[]> => {
    const res = await apiClient.get<DelegateSummary[]>(
      '/delegation/delegates',
    );
    return res.data;
  },

  lookupEmail: async (email: string): Promise<{ exists: boolean }> => {
    const res = await apiClient.get<{ exists: boolean }>(
      '/delegation/delegates/lookup',
      { params: { email } },
    );
    return res.data;
  },

  createDelegate: async (
    payload: CreateDelegatePayload,
  ): Promise<CreateDelegateResponse> => {
    const res = await apiClient.post('/delegation/delegates', payload);
    return res.data;
  },

  revokeDelegate: async (id: string): Promise<void> => {
    await apiClient.delete(`/delegation/delegates/${id}`);
  },

  setGrants: async (id: string, grants: AccountGrant[]): Promise<void> => {
    await apiClient.put(`/delegation/delegates/${id}/grants`, { grants });
  },

  setCapabilities: async (
    id: string,
    capabilities: DelegateCapabilities,
  ): Promise<void> => {
    await apiClient.put(
      `/delegation/delegates/${id}/capabilities`,
      capabilities,
    );
  },

  setSectionGrants: async (
    id: string,
    sections: DelegateSectionFlags,
  ): Promise<void> => {
    await apiClient.put(`/delegation/delegates/${id}/sections`, sections);
  },

  resetPassword: async (
    id: string,
  ): Promise<{ temporaryPassword: string }> => {
    const res = await apiClient.post(
      `/delegation/delegates/${id}/reset-password`,
    );
    return res.data;
  },
};
