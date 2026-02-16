import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';

const mockPush = vi.fn();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual('next/navigation');
  return {
    ...actual,
    useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
    usePathname: () => '/reports/custom/test-id/edit',
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

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div className="animate-spin" data-testid="loading-spinner">Loading</div>,
}));

// Mock React's use() to synchronously resolve the promise
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    use: (promise: any) => {
      if (promise && typeof promise.then === 'function') {
        return (promise as any)._resolvedValue ?? { id: 'report-1' };
      }
      return promise;
    },
  };
});

const mockReport = {
  id: 'report-1',
  name: 'My Test Report',
  description: 'A test report',
  metrics: [],
  filterGroups: [],
  groupBy: 'CATEGORY',
  timeframe: 'LAST_30_DAYS',
  viewType: 'BAR',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getById: (...args: any[]) => mockGetById(...args),
    update: (...args: any[]) => mockUpdate(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
}));

vi.mock('@/components/reports/CustomReportForm', () => ({
  CustomReportForm: (props: any) => (
    <div data-testid="custom-report-form">
      <span data-testid="form-report-name">{props.report?.name}</span>
      <button data-testid="form-submit" onClick={() => props.onSubmit({ name: 'Updated' })}>Submit</button>
      <button data-testid="form-cancel" onClick={props.onCancel}>Cancel</button>
    </div>
  ),
}));

function makeParams(id: string) {
  const p = Promise.resolve({ id });
  (p as any)._resolvedValue = { id };
  return p;
}

describe('EditCustomReportPage', () => {
  let EditCustomReportPage: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(mockReport);
    const mod = await import('./page');
    EditCustomReportPage = mod.default;
  });

  it('shows loading state then renders form', async () => {
    mockGetById.mockImplementation(() => new Promise(() => {}));
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('renders edit page with report data after loading', async () => {
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => {
      expect(screen.getByText('Edit Report')).toBeInTheDocument();
      expect(screen.getByText('Back to Reports')).toBeInTheDocument();
      expect(screen.getByText('Delete Report')).toBeInTheDocument();
    });
  });

  it('passes loaded report to form', async () => {
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => {
      expect(screen.getByTestId('form-report-name')).toHaveTextContent('My Test Report');
    });
  });

  it('navigates to report view after successful update', async () => {
    mockUpdate.mockResolvedValue(undefined);
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => screen.getByTestId('form-submit'));
    fireEvent.click(screen.getByTestId('form-submit'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('report-1', { name: 'Updated' });
      expect(mockPush).toHaveBeenCalledWith('/reports/custom/report-1');
    });
  });

  it('navigates back on cancel', async () => {
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => screen.getByTestId('form-cancel'));
    fireEvent.click(screen.getByTestId('form-cancel'));
    expect(mockPush).toHaveBeenCalledWith('/reports/custom/report-1');
  });

  it('shows delete confirmation modal', async () => {
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => screen.getByRole('button', { name: 'Delete Report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
    });
  });

  it('deletes report and navigates to reports list', async () => {
    mockDelete.mockResolvedValue(undefined);
    render(<EditCustomReportPage params={makeParams('report-1')} />);
    await waitFor(() => screen.getByRole('button', { name: 'Delete Report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    await waitFor(() => screen.getByTestId('modal'));
    const modal = screen.getByTestId('modal');
    const confirmBtn = modal.querySelector('button.bg-red-600') as HTMLElement;
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('report-1');
      expect(mockPush).toHaveBeenCalledWith('/reports');
    });
  });

  it('redirects to reports on load failure', async () => {
    mockGetById.mockRejectedValue(new Error('Not found'));
    render(<EditCustomReportPage params={makeParams('bad-id')} />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/reports');
    }, { timeout: 3000 });
  });
});
