import apiClient from './api';
import {
  User,
  UserPreferences,
  UpdateProfileData,
  UpdatePreferencesData,
  ChangePasswordData,
} from '@/types/auth';

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

  deleteAccount: async (): Promise<void> => {
    await apiClient.delete('/users/account');
  },
};
