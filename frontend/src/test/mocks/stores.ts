import { useAuthStore } from '@/store/authStore';

export function setAuthenticatedState() {
  useAuthStore.setState({
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      authProvider: 'local',
      hasPassword: true,
      role: 'user',
      isActive: true,
      mustChangePassword: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    isAuthenticated: true,
    isLoading: false,
    _hasHydrated: true,
    token: 'httpOnly',
    error: null,
  });
}

export function resetStores() {
  useAuthStore.getState().logout();
}
