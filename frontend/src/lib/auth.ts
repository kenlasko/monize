import apiClient from './api';
import { LoginCredentials, RegisterData, AuthResponse, TwoFactorSetupResponse, BackupCodesResponse, TrustedDevice, PersonalAccessToken, CreatePatData, CreatePatResponse } from '@/types/auth';

export interface AuthMethods {
  local: boolean;
  oidc: boolean;
  registration: boolean;
  smtp: boolean;
  force2fa: boolean;
  demo: boolean;
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

  // Authenticated user's OWN profile (delegate id, never the owner) -- the
  // Security view uses this while acting as a delegate so it manages the
  // actor's credentials, not the owner's.
  getSelfProfile: async () => {
    const response = await apiClient.get('/auth/me-self');
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

  verify2FA: async (tempToken: string, code: string, rememberDevice = false): Promise<AuthResponse> => {
    const response = await apiClient.post<AuthResponse>('/auth/2fa/verify', { tempToken, code, rememberDevice });
    return response.data;
  },

  setup2FA: async (currentPassword: string): Promise<TwoFactorSetupResponse> => {
    const response = await apiClient.post<TwoFactorSetupResponse>('/auth/2fa/setup', { currentPassword });
    return response.data;
  },

  confirmSetup2FA: async (code: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/2fa/confirm-setup', { code });
    return response.data;
  },

  generateBackupCodes: async (code: string): Promise<BackupCodesResponse> => {
    const response = await apiClient.post<BackupCodesResponse>('/auth/2fa/backup-codes', { code });
    return response.data;
  },

  disable2FA: async (code: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/2fa/disable', { code });
    return response.data;
  },

  get2FAStatus: async (): Promise<{ enabled: boolean }> => {
    const response = await apiClient.get<{ enabled: boolean }>('/auth/2fa/status');
    return response.data;
  },

  getTrustedDevices: async (): Promise<TrustedDevice[]> => {
    const response = await apiClient.get<TrustedDevice[]>('/auth/2fa/trusted-devices');
    return response.data;
  },

  revokeTrustedDevice: async (id: string): Promise<{ message: string }> => {
    const response = await apiClient.delete<{ message: string }>(`/auth/2fa/trusted-devices/${id}`);
    return response.data;
  },

  revokeAllTrustedDevices: async (): Promise<{ message: string; count: number }> => {
    const response = await apiClient.delete<{ message: string; count: number }>('/auth/2fa/trusted-devices');
    return response.data;
  },

  getTokens: async (): Promise<PersonalAccessToken[]> => {
    const response = await apiClient.get<PersonalAccessToken[]>('/auth/tokens');
    return response.data;
  },

  createToken: async (data: CreatePatData): Promise<CreatePatResponse> => {
    const response = await apiClient.post<CreatePatResponse>('/auth/tokens', data);
    return response.data;
  },

  revokeToken: async (id: string): Promise<{ message: string }> => {
    const response = await apiClient.delete<{ message: string }>(`/auth/tokens/${id}`);
    return response.data;
  },
};
