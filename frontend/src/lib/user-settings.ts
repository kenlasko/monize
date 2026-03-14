import apiClient from './api';
import {
  User,
  UserPreferences,
  UpdateProfileData,
  UpdatePreferencesData,
  ChangePasswordData,
} from '@/types/auth';

export interface DeleteDataOptions {
  password?: string;
  oidcIdToken?: string;
  deleteAccounts?: boolean;
  deleteCategories?: boolean;
  deletePayees?: boolean;
  deleteExchangeRates?: boolean;
}

export interface DeleteDataResult {
  deleted: Record<string, number>;
}

export const userSettingsApi = {
  getProfile: async (): Promise<User> => {
    const response = await apiClient.get<User>('/users/me');
    return response.data;
  },

  updateProfile: async (data: UpdateProfileData): Promise<User> => {
    const response = await apiClient.patch<User>('/users/profile', data);
    return response.data;
  },

  getPreferences: async (): Promise<UserPreferences> => {
    const response = await apiClient.get<UserPreferences>('/users/preferences');
    return response.data;
  },

  updatePreferences: async (data: UpdatePreferencesData): Promise<UserPreferences> => {
    const response = await apiClient.patch<UserPreferences>('/users/preferences', data);
    return response.data;
  },

  changePassword: async (data: ChangePasswordData): Promise<void> => {
    await apiClient.post('/users/change-password', data);
  },

  deleteAccount: async (data: { password?: string; oidcIdToken?: string }): Promise<void> => {
    await apiClient.post('/users/delete-account', data, { timeout: 120000 });
  },

  getSmtpStatus: async (): Promise<{ configured: boolean }> => {
    const response = await apiClient.get<{ configured: boolean }>('/notifications/smtp-status');
    return response.data;
  },

  sendTestEmail: async (): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/notifications/test-email');
    return response.data;
  },

  deleteData: async (options: DeleteDataOptions): Promise<DeleteDataResult> => {
    const response = await apiClient.post<DeleteDataResult>('/users/delete-data', options, {
      timeout: 120000,
    });
    return response.data;
  },
};
