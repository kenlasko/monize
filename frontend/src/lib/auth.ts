import apiClient from './api';
import { LoginCredentials, RegisterData, AuthResponse, TwoFactorSetupResponse, BackupCodesResponse, TrustedDevice, PersonalAccessToken, CreatePatData, CreatePatResponse, User, SelfUserProfile } from '@/types/auth';

export interface AuthMethods {
  local: boolean;
  oidc: boolean;
  registration: boolean;
  smtp: boolean;
  force2fa: boolean;
  /** SSO accounts with a local password may sign in with it and enroll app TOTP. */
  oidcPasswordLogin?: boolean;
  demo: boolean;
  /** False when the admin hides the brand panel (and its sample-data screenshot) on the auth screens. */
  brandPanel?: boolean;
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

  // Acting-context profile: identifies whose finances are on screen. While a
  // delegate is acting this omits the owner's credential-state fields, so the
  // return type keeps them optional.
  getProfile: async (): Promise<User | null> => {
    const response = await apiClient.get<User | null>('/auth/profile');
    return response.data;
  },

  // Authenticated user's OWN profile (delegate id, never the owner) -- the
  // Security view uses this while acting as a delegate so it manages the
  // actor's credentials, not the owner's. Always a complete row.
  getSelfProfile: async (): Promise<SelfUserProfile | null> => {
    const response = await apiClient.get<SelfUserProfile | null>('/auth/me-self');
    return response.data;
  },

  getAuthMethods: async (): Promise<AuthMethods> => {
    const response = await apiClient.get<AuthMethods>('/auth/methods');
    return response.data;
  },

  initiateOidc: () => {
    // Use relative URL - Next.js rewrites handle routing to backend, which
    // issues a 302 to the external IdP; router.push() would only change the
    // client-side route and never follow that redirect.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full browser navigation required to follow the backend's redirect to the IdP
    window.location.href = '/api/v1/auth/oidc';
  },

  /**
   * Start an OIDC *re-authentication* for a destructive action.
   *
   * Different route from initiateOidc: it requires the current session, names the
   * action, and asks the provider to challenge the user again. The callback comes
   * back with a signed artifact the server will verify -- previously the client
   * simply claimed the round trip had happened (P2-005).
   */
  beginOidcReauth: (purpose: string) => {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full browser navigation required to follow the backend's redirect to the IdP
    window.location.href = `/api/v1/auth/oidc/reauth?purpose=${encodeURIComponent(purpose)}`;
  },

  forgotPassword: async (email: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/forgot-password', { email });
    return response.data;
  },

  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/reset-password', { token, newPassword });
    return response.data;
  },

  verifyEmail: async (token: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/verify-email', { token });
    return response.data;
  },

  confirmEmailChange: async (token: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/confirm-email-change', { token });
    return response.data;
  },

  resendVerification: async (email: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/resend-verification', { email });
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

  /**
   * Replace an exposed or unusable authenticator: needs the account password
   * and an authenticator or backup code, and works under FORCE_2FA. The
   * session making the request is kept, so enrollment can follow at once.
   */
  reset2FA: async (currentPassword: string, code: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>('/auth/2fa/reset', { currentPassword, code });
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

  /**
   * Minting a PAT is step-up protected (purpose `personal-access-token`): pass
   * the token from `useStepUpTokenStore`. Without one the server answers
   * `STEP_UP_REQUIRED`, which the caller maps with `rethrowStepUpError`.
   */
  createToken: async (
    data: CreatePatData,
    stepUpToken?: string | null,
  ): Promise<CreatePatResponse> => {
    const response = stepUpToken
      ? await apiClient.post<CreatePatResponse>('/auth/tokens', data, {
          headers: { 'X-Step-Up-Token': stepUpToken },
        })
      : await apiClient.post<CreatePatResponse>('/auth/tokens', data);
    return response.data;
  },

  revokeToken: async (id: string): Promise<{ message: string }> => {
    const response = await apiClient.delete<{ message: string }>(`/auth/tokens/${id}`);
    return response.data;
  },
};
