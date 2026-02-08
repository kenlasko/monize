export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  authProvider: 'local' | 'oidc';
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

export interface AdminUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  authProvider: 'local' | 'oidc';
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLogin: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UserPreferences {
  userId: string;
  defaultCurrency: string;
  dateFormat: string; // 'browser' = use browser locale
  numberFormat: string; // 'browser' = use browser locale
  theme: 'light' | 'dark' | 'system';
  timezone: string; // 'browser' = use browser timezone
  notificationEmail: boolean;
  notificationBrowser: boolean;
  twoFactorEnabled: boolean;
  gettingStartedDismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface UpdatePreferencesData {
  defaultCurrency?: string;
  dateFormat?: string;
  numberFormat?: string;
  theme?: 'light' | 'dark' | 'system';
  timezone?: string;
  notificationEmail?: boolean;
  notificationBrowser?: boolean;
  gettingStartedDismissed?: boolean;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
}
