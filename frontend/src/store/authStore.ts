import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '@/types/auth';

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
      // SECURITY: Do NOT persist token to localStorage - XSS vulnerable
      // Token should only be in httpOnly cookies managed by backend
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
