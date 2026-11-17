import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from './authStore';
import { beginSignOut, isSigningOut } from '@/lib/logout-state';
import {
  buildIntradayCacheKey,
  readIntradayCache,
  writeIntradayCache,
  type IntradayCachePayload,
} from '@/components/investments/portfolio-chart-utils';
import { LAST_TRANSACTION_CURRENCY_KEY } from '@/lib/lastTransactionCurrency';
import { readPageSnapshot, writePageSnapshot } from '@/lib/page-snapshot';
import {
  LAST_TRANSACTION_DATE_KEY,
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
} from '@/lib/lastTransactionDate';

// A single top-level mock for @/lib/auth -- the rehydration tests each
// reconfigure rehydrateGetProfileMock to control how getProfile
// resolves/rejects. The earlier per-test vi.doMock pattern was unreliable
// because Vitest caches a module after its first dynamic import, so the
// next test's vi.doMock would not take effect for the dynamic
// import('@/lib/auth') inside onRehydrateStorage -- producing a flaky
// failure on slower CI runners (see PR #556).
const rehydrateGetProfileMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  authApi: {
    getProfile: rehydrateGetProfileMock,
  },
}));

// The rehydrate chain asks for the profile AND the delegation context in one
// `Promise.all`, so mocking only the first leaves the second on the real
// `apiClient`. In jsdom that is a real request to the environment's origin,
// `http://localhost:3000` -- which on a machine running the dev stack is the
// backend. It answers 401, the client's 401 interceptor calls `logout()`, and
// the store loses `isAuthenticated` partway through whichever test is running
// when the round trip lands. The suite passes on a machine with nothing on that
// port and fails on a developer's, which is the worst way for a test to be
// wrong.
const rehydrateGetContextsMock = vi.fn();
vi.mock('@/lib/delegation', () => ({
  delegationApi: {
    getContexts: rehydrateGetContextsMock,
  },
}));

const clearShareInboxMock = vi.fn();
vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  clearShareInbox: clearShareInboxMock,
}));

describe('authStore', () => {
  beforeEach(() => {
    rehydrateGetProfileMock.mockReset();
    rehydrateGetContextsMock.mockReset();
    // The default every rehydration test wants: a user with no delegations
    // still gets a successful empty payload, and the chain's own `.catch`
    // turns a failure into "no delegation context" rather than a logout.
    rehydrateGetContextsMock.mockResolvedValue({
      actingAsUserId: null,
      contexts: [],
      capabilities: null,
      sections: null,
    });
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

    it('ends an earlier sign-out so 401 recovery applies again', () => {
      beginSignOut();
      useAuthStore.getState().login(mockUser, 'httpOnly');
      expect(isSigningOut()).toBe(false);
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

    it("drops the pages' last-drawn data so the next identity is not shown it", () => {
      writePageSnapshot('accounts', { accounts: [{ id: 'a1', name: 'Private' }] });
      useAuthStore.getState().logout();
      expect(readPageSnapshot('accounts')).toBeUndefined();
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

    it('empties the in-memory AI chat so the next user on the tab does not see it', async () => {
      const { useAiChatStore } = await import('./aiChatStore');
      useAiChatStore.setState({
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'private',
            timestamp: Date.now(),
          } as never,
        ],
      });

      useAuthStore.getState().logout();

      await vi.waitFor(() =>
        expect(useAiChatStore.getState().messages).toEqual([]),
      );
    });

    // A share is one account's document sitting in this browser's storage. The
    // next account to sign in on a shared device must not find it waiting.
    it('clears the web-share stash so it does not leak across accounts', async () => {
      useAuthStore.getState().logout();

      // The store reaches the module through a dynamic import, so the call
      // lands a microtask later.
      await vi.waitFor(() => expect(clearShareInboxMock).toHaveBeenCalled());
    });
  });

  // INV-SHARE-003: a cache one identity wrote is never drawn for the next.
  describe('identity-scoped session storage', () => {
    const payload: IntradayCachePayload = {
      fetchedAt: 1,
      points: [{ timestamp: '2026-01-01T10:00:00Z', value: 1000 }],
      interval: '5m',
      currency: 'USD',
      fallbackToDaily: false,
      skippedSymbols: [],
      failedSymbols: [],
    };

    it('clears the intraday portfolio cache on logout', () => {
      useAuthStore.getState().login(mockUser, 'httpOnly');
      const key = buildIntradayCacheKey('1d', ['a1'], 'USD');
      writeIntradayCache(key, payload);
      expect(readIntradayCache(key)).not.toBeNull();

      useAuthStore.getState().logout();

      expect(window.sessionStorage.getItem(key)).toBeNull();
    });

    it('clears the remembered transaction date and currency on logout', () => {
      for (const k of [
        LAST_TRANSACTION_DATE_KEY,
        LAST_INVESTMENT_TRANSACTION_DATE_KEY,
        LAST_TRANSACTION_CURRENCY_KEY,
      ]) {
        window.sessionStorage.setItem(k, '{"savedAt":1}');
      }

      useAuthStore.getState().logout();

      expect(window.sessionStorage.getItem(LAST_TRANSACTION_DATE_KEY)).toBeNull();
      expect(
        window.sessionStorage.getItem(LAST_INVESTMENT_TRANSACTION_DATE_KEY),
      ).toBeNull();
      expect(
        window.sessionStorage.getItem(LAST_TRANSACTION_CURRENCY_KEY),
      ).toBeNull();
    });

    it('leaves an entry written by user A unreadable once user B signs in', () => {
      useAuthStore.getState().login(mockUser, 'httpOnly');
      const keyA = buildIntradayCacheKey('1d', ['a1'], 'USD');
      writeIntradayCache(keyA, payload);

      // No logout: the same tab, a second identity.
      useAuthStore.setState({ user: { ...mockUser, id: 'user-2' } });
      const keyB = buildIntradayCacheKey('1d', ['a1'], 'USD');

      expect(keyB).not.toBe(keyA);
      expect(readIntradayCache(keyB)).toBeNull();
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

  // What this store may write to localStorage lives in
  // persisted-storage.guard.test.ts, which runs partialize over a populated
  // state and asserts the pre-login footprint byte for byte. The test that
  // used to sit here asserted only that a persist API existed, under a title
  // claiming it checked the token was excluded.

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
      rehydrateGetProfileMock.mockRejectedValueOnce(error502);

      // Call onRehydrate with the current state
      onRehydrate(useAuthStore.getState());

      // Wait until the async rehydrate chain (two dynamic imports + a
      // Promise.all over two API calls + the .catch handler) settles.
      // The terminal state in every branch is _hasHydrated=true; a
      // fixed setTimeout(50) was enough locally but flaked on slower
      // CI runners (see PR #556).
      await vi.waitFor(() =>
        expect(useAuthStore.getState()._hasHydrated).toBe(true),
      );

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state._hasHydrated).toBe(true);
      expect(useConnectionStore.getState().isBackendDown).toBe(true);
      // The chain really went through the mocked delegation client. Drop that
      // mock and the call leaves the process instead, which is invisible on a
      // machine with nothing listening on the jsdom origin's port and a logout
      // partway through a later test on one that has the dev stack up.
      expect(rehydrateGetContextsMock).toHaveBeenCalled();
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

      rehydrateGetProfileMock.mockRejectedValueOnce(error401);

      onRehydrate(useAuthStore.getState());

      await vi.waitFor(() =>
        expect(useAuthStore.getState()._hasHydrated).toBe(true),
      );

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state._hasHydrated).toBe(true);
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

      rehydrateGetProfileMock.mockRejectedValueOnce(networkError);

      onRehydrate(useAuthStore.getState());

      await vi.waitFor(() =>
        expect(useAuthStore.getState()._hasHydrated).toBe(true),
      );

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state._hasHydrated).toBe(true);
      expect(useConnectionStore.getState().isBackendDown).toBe(true);
    });

    it('logs out on non-AxiosError during rehydration', async () => {
      useAuthStore.setState({
        isAuthenticated: true,
        user: null,
        _hasHydrated: false,
        isLoading: true,
      });

      const persistApi = (useAuthStore as any).persist;
      const options = persistApi.getOptions();
      const onRehydrate = options.onRehydrateStorage();

      rehydrateGetProfileMock.mockRejectedValueOnce(new Error('unexpected'));

      onRehydrate(useAuthStore.getState());

      await vi.waitFor(() =>
        expect(useAuthStore.getState()._hasHydrated).toBe(true),
      );

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state._hasHydrated).toBe(true);
    });
  });
});
