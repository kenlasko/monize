import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '@/types/auth';
import { clearAllCache } from '@/lib/apiCache';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  _hasHydrated: boolean;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User, token: string) => void;
  logout: () => void;
  clearError: () => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
      _hasHydrated: false,

      setUser: (user) => set({ user, isAuthenticated: !!user }),

      // auth_token is httpOnly — backend manages the cookie, not JS
      setToken: (token) => set({ token }),

      setError: (error) => set({ error }),

      setLoading: (loading) => set({ isLoading: loading }),

      login: (user, token) => {
        // Backend sets httpOnly cookies; we only track auth state in Zustand
        set({
          user,
          token,
          isAuthenticated: true,
          error: null,
          isLoading: false,
        });
      },

      logout: () => {
        // Backend clears httpOnly cookies via /auth/logout; we only clear Zustand state
        clearAllCache();
        // SECURITY: Clear preferences store to remove userId from localStorage
        import('@/store/preferencesStore').then(({ usePreferencesStore }) => {
          usePreferencesStore.getState().clearPreferences();
        });
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          error: null,
          isLoading: false,
        });
      },

      clearError: () => set({ error: null }),

      setHasHydrated: (state) => {
        set({ _hasHydrated: state, isLoading: false });
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage),
      // SECURITY: Only persist isAuthenticated flag to localStorage.
      // User PII (email, name, role) is fetched from API on page load.
      // Token is in httpOnly cookies managed by backend.
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.isAuthenticated) {
          // Fetch user profile from API to restore user object without persisting PII
          import('@/lib/auth').then(({ authApi }) => {
            authApi.getProfile().then((user: User) => {
              state.setUser(user);
              state.setHasHydrated(true);
            }).catch(() => {
              // Profile fetch failed (session expired) — log out
              state.logout();
              state.setHasHydrated(true);
            });
          });
        } else {
          state?.setHasHydrated(true);
        }
      },
    }
  )
);
