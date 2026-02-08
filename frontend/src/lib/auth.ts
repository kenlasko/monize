import apiClient from './api';
import { LoginCredentials, RegisterData, AuthResponse } from '@/types/auth';

export interface AuthMethods {
  local: boolean;
  oidc: boolean;
  registration: boolean;
  smtp: boolean;
}

export const authApi = {
  login: async (credentials: LoginCredentials): Promise<AuthResponse> => {
    const response = await apiClient.post<AuthResponse>('/auth/login', credentials);
    return response.data;
  },

  register: async (data: RegisterData): Promise<AuthResponse> => {
    const response = await apiClient.post<AuthResponse>('/auth/register', data);
    return response.data;
  },

  logout: async (): Promise<void> => {
    await apiClient.post('/auth/logout');
  },

  getProfile: async () => {
    const response = await apiClient.get('/auth/profile');
    return response.data;
  },

  getAuthMethods: async (): Promise<AuthMethods> => {
    const response = await apiClient.get<AuthMethods>('/auth/methods');
    return response.data;
  },

  initiateOidc: () => {
    // Use relative URL - Next.js rewrites handle routing to backend
    window.location.href = '/api/v1/auth/oidc';
  },

  forgotPassword: async (email: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/forgot-password', { email });
    return response.data;
  },

  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/reset-password', { token, newPassword });
    return response.data;
  },
};
