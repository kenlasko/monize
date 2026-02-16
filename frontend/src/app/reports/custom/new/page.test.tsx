import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import NewCustomReportPage from './page';

const mockPush = vi.fn();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation');
  return {
    ...actual,
    useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
    usePathname: () => '/reports/custom/new',
    useSearchParams: () => new URLSearchParams(),
  };
});

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
    getAuthMethods: vi.fn().mockResolvedValue({ local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Mock CustomReportForm
vi.mock('@/components/reports/CustomReportForm', () => ({
  CustomReportForm: (props: any) => (
    <div data-testid="custom-report-form">
      <button data-testid="form-submit" onClick={() => props.onSubmit({ name: 'Test' })}>Submit</button>
      <button data-testid="form-cancel" onClick={props.onCancel}>Cancel</button>
    </div>
  ),
}));

const mockCreate = vi.fn();
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    create: (...args: any[]) => mockCreate(...args),
  },
}));

describe('NewCustomReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title and subtitle', async () => {
    render(<NewCustomReportPage />);
    await waitFor(() => {
      expect(screen.getByText('Create Custom Report')).toBeInTheDocument();
      expect(screen.getByText(/Define how you want to view/)).toBeInTheDocument();
    });
  });

  it('renders Back to Reports button', async () => {
    render(<NewCustomReportPage />);
    await waitFor(() => {
      expect(screen.getByText('Back to Reports')).toBeInTheDocument();
    });
  });

  it('renders the custom report form', async () => {
    render(<NewCustomReportPage />);
    await waitFor(() => {
      expect(screen.getByTestId('custom-report-form')).toBeInTheDocument();
    });
  });

  it('navigates to report view after successful creation', async () => {
    mockCreate.mockResolvedValue({ id: 'new-report-id' });
    render(<NewCustomReportPage />);
    await waitFor(() => {
      screen.getByTestId('form-submit').click();
    });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/reports/custom/new-report-id');
    });
  });

  it('navigates back on cancel', async () => {
    render(<NewCustomReportPage />);
    await waitFor(() => {
      screen.getByTestId('form-cancel').click();
    });
    expect(mockPush).toHaveBeenCalledWith('/reports/custom');
  });
});
