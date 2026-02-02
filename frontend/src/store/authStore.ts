import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import Cookies from 'js-cookie';
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

      setToken: (token) => {
        if (token) {
          // Note: httpOnly cannot be set from JS - backend should manage auth cookies
          // Adding secure flag for HTTPS in production
          Cookies.set('auth_token', token, {
            expires: 7,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          });
        } else {
          Cookies.remove('auth_token');
        }
        set({ token });
      },

      setError: (error) => set({ error }),

      setLoading: (loading) => set({ isLoading: loading }),

      login: (user, token) => {
        // Note: httpOnly cannot be set from JS - backend should manage auth cookies
        // For OIDC flow, backend sets httpOnly cookie; this is for local auth fallback
        if (token && token !== 'httpOnly') {
          Cookies.set('auth_token', token, {
            expires: 7,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
          });
        }
        set({
          user,
          token,
          isAuthenticated: true,
          error: null,
          isLoading: false,
        });
      },

      logout: () => {
        Cookies.remove('auth_token');
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
