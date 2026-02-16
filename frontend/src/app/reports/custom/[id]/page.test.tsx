import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation');
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    usePathname: () => '/reports/custom/test-id',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'user-1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true, isLoading: false, _hasHydrated: true, logout: vi.fn(),
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

// Mock CustomReportViewer since it has its own tests
vi.mock('@/components/reports/CustomReportViewer', () => ({
  CustomReportViewer: ({ reportId }: { reportId: string }) => (
    <div data-testid="custom-report-viewer">Viewing report: {reportId}</div>
  ),
}));

// Mock React's use() to synchronously resolve the promise
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    use: (promise: any) => {
      if (promise && typeof promise.then === 'function') {
        // Return a pre-resolved value for testing
        return (promise as any)._resolvedValue ?? { id: 'test-report-123' };
      }
      return promise;
    },
  };
});

describe('ViewCustomReportPage', () => {
  it('renders CustomReportViewer with the report ID', async () => {
    // Import after mocks are set up
    const { default: ViewCustomReportPage } = await import('./page');
    const resolvedPromise = Promise.resolve({ id: 'test-report-123' });
    (resolvedPromise as any)._resolvedValue = { id: 'test-report-123' };
    render(<ViewCustomReportPage params={resolvedPromise} />);
    await waitFor(() => {
      expect(screen.getByTestId('custom-report-viewer')).toBeInTheDocument();
      expect(screen.getByText('Viewing report: test-report-123')).toBeInTheDocument();
    });
  });
});
