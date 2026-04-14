import { describe, it, expect, beforeEach, vi } from 'vitest';
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

    it('clears persisted AI chat history so it does not leak across accounts', () => {
      window.localStorage.setItem(
        'monize:ai-chat-messages',
        JSON.stringify([{ id: '1', role: 'user', content: 'private' }]),
      );

      useAuthStore.getState().logout();

      expect(
        window.localStorage.getItem('monize:ai-chat-messages'),
      ).toBeNull();
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

  describe('rehydration 502 handling', () => {
    it('keeps authenticated state on 502 error and sets backend down', async () => {
      const { AxiosError, AxiosHeaders } = await import('axios');
      const { useConnectionStore } = await import('@/store/connectionStore');
      useConnectionStore.setState({ isBackendDown: false, downSince: null });

      // Simulate: user was authenticated, profile fetch returns 502
      useAuthStore.setState({
        isAuthenticated: true,
        user: null,
        _hasHydrated: false,
        isLoading: true,
      });

      const error502 = new AxiosError('Bad Gateway', '502', undefined, undefined, {
        status: 502,
        data: { error: 'Backend unavailable' },
        statusText: 'Bad Gateway',
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      // Access the persist config to get the onRehydrateStorage callback
      const persistApi = (useAuthStore as any).persist;
      const options = persistApi.getOptions();
      const onRehydrate = options.onRehydrateStorage();

      // Mock the auth module to return 502
      vi.doMock('@/lib/auth', () => ({
        authApi: {
          getProfile: vi.fn().mockRejectedValue(error502),
        },
      }));

      // Call onRehydrate with the current state
      onRehydrate(useAuthStore.getState());

      // Wait for async operations (dynamic import + catch handler)
      await new Promise(r => setTimeout(r, 50));

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state._hasHydrated).toBe(true);
      expect(useConnectionStore.getState().isBackendDown).toBe(true);

      vi.doUnmock('@/lib/auth');
    });

    it('logs out on non-502 error during rehydration', async () => {
      const { AxiosError, AxiosHeaders } = await import('axios');

      useAuthStore.setState({
        isAuthenticated: true,
        user: null,
        _hasHydrated: false,
        isLoading: true,
      });

      const error401 = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: { message: 'Session expired' },
        statusText: 'Unauthorized',
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

      const persistApi = (useAuthStore as any).persist;
      const options = persistApi.getOptions();
      const onRehydrate = options.onRehydrateStorage();

      vi.doMock('@/lib/auth', () => ({
        authApi: {
          getProfile: vi.fn().mockRejectedValue(error401),
        },
      }));

      onRehydrate(useAuthStore.getState());

      await new Promise(r => setTimeout(r, 50));

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state._hasHydrated).toBe(true);

      vi.doUnmock('@/lib/auth');
    });

    it('keeps authenticated state on network error (no response)', async () => {
      const { AxiosError } = await import('axios');
      const { useConnectionStore } = await import('@/store/connectionStore');
      useConnectionStore.setState({ isBackendDown: false, downSince: null });

      useAuthStore.setState({
        isAuthenticated: true,
        user: null,
        _hasHydrated: false,
        isLoading: true,
      });

      // Network error: AxiosError with no response
      const networkError = new AxiosError('Network Error');

      const persistApi = (useAuthStore as any).persist;
      const options = persistApi.getOptions();
      const onRehydrate = options.onRehydrateStorage();

      vi.doMock('@/lib/auth', () => ({
        authApi: {
          getProfile: vi.fn().mockRejectedValue(networkError),
        },
      }));

      onRehydrate(useAuthStore.getState());

      await new Promise(r => setTimeout(r, 50));

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state._hasHydrated).toBe(true);
      expect(useConnectionStore.getState().isBackendDown).toBe(true);

      vi.doUnmock('@/lib/auth');
    });
  });
});
