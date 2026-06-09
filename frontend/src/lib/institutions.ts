import apiClient from './api';
import {
  Institution,
  CreateInstitutionData,
  UpdateInstitutionData,
} from '@/types/institution';
import { Account } from '@/types/account';
import { dedupe, invalidateCache } from './apiCache';

/**
 * Same-origin URL for an institution's cached brand favicon. Rendered directly
 * in an <img>; the request carries the auth cookie and never contacts a third
 * party. Returns 404 when no logo is cached, so callers should provide a
 * fallback (handled by the InstitutionLogo component's onError).
 */
export function institutionLogoUrl(id: string): string {
  return `/api/v1/institutions/${id}/logo`;
}

export const institutionsApi = {
  getAll: async (): Promise<Institution[]> => {
    return dedupe(
      'institutions:all',
      async () => {
        const response = await apiClient.get<Institution[]>('/institutions');
        return response.data;
      },
      300_000, // 5 min
    );
  },

  getById: async (id: string): Promise<Institution> => {
    const response = await apiClient.get<Institution>(`/institutions/${id}`);
    return response.data;
  },

  create: async (data: CreateInstitutionData): Promise<Institution> => {
    const response = await apiClient.post<Institution>('/institutions', data);
    invalidateCache('institutions:');
    return response.data;
  },

  update: async (
    id: string,
    data: UpdateInstitutionData,
  ): Promise<Institution> => {
    const response = await apiClient.patch<Institution>(
      `/institutions/${id}`,
      data,
    );
    invalidateCache('institutions:');
    invalidateCache('accounts:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/institutions/${id}`);
    invalidateCache('institutions:');
    invalidateCache('accounts:');
  },

  refreshLogo: async (id: string): Promise<Institution> => {
    const response = await apiClient.post<Institution>(
      `/institutions/${id}/refresh-logo`,
    );
    invalidateCache('institutions:');
    return response.data;
  },

  getAccounts: async (id: string): Promise<Account[]> => {
    const response = await apiClient.get<Account[]>(
      `/institutions/${id}/accounts`,
    );
    return response.data;
  },

  assignAccount: async (id: string, accountId: string): Promise<Account> => {
    const response = await apiClient.post<Account>(
      `/institutions/${id}/accounts`,
      { accountId },
    );
    invalidateCache('institutions:');
    invalidateCache('accounts:');
    return response.data;
  },

  unassignAccount: async (id: string, accountId: string): Promise<Account> => {
    const response = await apiClient.delete<Account>(
      `/institutions/${id}/accounts/${accountId}`,
    );
    invalidateCache('institutions:');
    invalidateCache('accounts:');
    return response.data;
  },
};
