import apiClient from './api';

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
}

/** Owner-grantable READ sections (gate tab visibility + section endpoints). */
export interface DelegateSectionGrants {
  bills: boolean;
  investments: boolean;
  budgets: boolean;
  reports: boolean;
  ai: boolean;
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
