import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import ReportsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock custom reports API
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

// Mock IconPicker
vi.mock('@/components/ui/IconPicker', () => ({
  getIconComponent: () => null,
}));

// Mock AppHeader
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Reports heading', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Reports')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Generate insights/i)).toBeInTheDocument();
    });
  });

  it('renders built-in report cards', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
      expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
      expect(screen.getByText('Net Worth Over Time')).toBeInTheDocument();
    });
  });

  it('renders the All Reports filter button', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All Reports' })).toBeInTheDocument();
    });
  });

  it('renders report count', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/reports? available/i)).toBeInTheDocument();
    });
  });
});
