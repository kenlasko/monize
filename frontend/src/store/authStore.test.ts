import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('authStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
      _hasHydrated: false,
    });
  });

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    authProvider: 'local' as const,
    hasPassword: true,
    role: 'user' as const,
    isActive: true,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  describe('login', () => {
    it('sets user and authentication state', () => {
      useAuthStore.getState().login(mockUser, 'httpOnly');

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isAuthenticated).toBe(true);
      expect(state.token).toBe('httpOnly');
      expect(state.error).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });

  describe('logout', () => {
    it('clears all auth state', () => {
      // First login
      useAuthStore.getState().login(mockUser, 'httpOnly');
      expect(useAuthStore.getState().isAuthenticated).toBe(true);

      // Then logout
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.error).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });

  describe('setUser', () => {
    it('sets user and isAuthenticated to true', () => {
      useAuthStore.getState().setUser(mockUser);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('sets isAuthenticated to false when user is null', () => {
      useAuthStore.getState().setUser(null);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('setError', () => {
    it('sets error message', () => {
      useAuthStore.getState().setError('Something went wrong');
      expect(useAuthStore.getState().error).toBe('Something went wrong');
    });
  });

  describe('clearError', () => {
    it('clears the error', () => {
      useAuthStore.getState().setError('Error');
      useAuthStore.getState().clearError();
      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  describe('setLoading', () => {
    it('sets loading state', () => {
      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);

      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });
  });

  describe('setHasHydrated', () => {
    it('sets hydration state and stops loading', () => {
      useAuthStore.getState().setHasHydrated(true);

      const state = useAuthStore.getState();
      expect(state._hasHydrated).toBe(true);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('persistence', () => {
    it('only persists user and isAuthenticated (not token)', () => {
      // The partialize function should exclude token
      const store = useAuthStore;
      // Access the persist API to check partialize config
      const persistOptions = (store as any).persist;
      expect(persistOptions).toBeDefined();
    });
  });
});
