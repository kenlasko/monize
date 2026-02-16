import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import ReportPage from './page';

// Mock next/navigation
const mockUseParams = vi.fn();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation');
  return {
    ...actual,
    useParams: () => mockUseParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    usePathname: () => '/reports/spending-by-category',
    useSearchParams: () => new URLSearchParams(),
  };
});

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'user-1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    { getState: vi.fn(() => ({ isAuthenticated: true, _hasHydrated: true })) },
  ),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = { preferences: { twoFactorEnabled: false, theme: 'system' }, isLoaded: true, _hasHydrated: true };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({ local: true, oidc: false, registration: true, smtp: false, force2fa: false }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

describe('ReportPage', () => {
  it('renders report not found for invalid reportId', async () => {
    mockUseParams.mockReturnValue({ reportId: 'nonexistent-report' });
    render(<ReportPage />);
    await waitFor(() => {
      expect(screen.getByText('Report Not Found')).toBeInTheDocument();
    });
  });

  it('renders report title and back button for valid reportId', async () => {
    mockUseParams.mockReturnValue({ reportId: 'spending-by-category' });
    render(<ReportPage />);
    await waitFor(() => {
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
      expect(screen.getByText('Back to Reports')).toBeInTheDocument();
    });
  });

  it('renders report description for valid reportId', async () => {
    mockUseParams.mockReturnValue({ reportId: 'net-worth' });
    render(<ReportPage />);
    await waitFor(() => {
      expect(screen.getByText('Net Worth Over Time')).toBeInTheDocument();
      expect(screen.getByText(/Track your total net worth/)).toBeInTheDocument();
    });
  });
});
