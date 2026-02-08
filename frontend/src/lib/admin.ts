import apiClient from './api';
import { AdminUser } from '@/types/auth';

export interface ResetPasswordResponse {
  temporaryPassword: string;
}

export const adminApi = {
  getUsers: async (): Promise<AdminUser[]> => {
    const response = await apiClient.get<AdminUser[]>('/admin/users');
    return response.data;
  },

  updateUserRole: async (
    userId: string,
    role: 'admin' | 'user',
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/role`,
      { role },
    );
    return response.data;
  },

  updateUserStatus: async (
    userId: string,
    isActive: boolean,
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/status`,
      { isActive },
    );
    return response.data;
  },

  deleteUser: async (userId: string): Promise<void> => {
    await apiClient.delete(`/admin/users/${userId}`);
  },

  resetUserPassword: async (
    userId: string,
  ): Promise<ResetPasswordResponse> => {
    const response = await apiClient.post<ResetPasswordResponse>(
      `/admin/users/${userId}/reset-password`,
    );
    return response.data;
  },
};
