import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetAlertBadge } from './BudgetAlertBadge';
import type { BudgetAlert } from '@/types/budget';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/budgets',
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetAlerts = vi.fn();
const mockMarkAlertRead = vi.fn();
const mockMarkAllAlertsRead = vi.fn();
const mockDeleteAlert = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAlerts: (...args: any[]) => mockGetAlerts(...args),
    markAlertRead: (...args: any[]) => mockMarkAlertRead(...args),
    markAllAlertsRead: (...args: any[]) => mockMarkAllAlertsRead(...args),
    deleteAlert: (...args: any[]) => mockDeleteAlert(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const makeAlert = (overrides: Partial<BudgetAlert> = {}): BudgetAlert => ({
  id: 'alert-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  alertType: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('BudgetAlertBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAlerts.mockResolvedValue([]);
    mockMarkAlertRead.mockResolvedValue({});
    mockMarkAllAlertsRead.mockResolvedValue({ updated: 0 });
    mockDeleteAlert.mockResolvedValue(undefined);
  });

  it('renders the bell icon button', async () => {
    render(<BudgetAlertBadge />);
    await act(async () => {});

    expect(screen.getByTestId('alert-badge-button')).toBeInTheDocument();
  });

  it('fetches alerts on mount', async () => {
    render(<BudgetAlertBadge />);
    await act(async () => {});

    expect(mockGetAlerts).toHaveBeenCalled();
  });

  it('shows unread count badge when there are unread alerts', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: false }),
      makeAlert({ id: 'a3', isRead: true }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    expect(screen.getByTestId('unread-count')).toHaveTextContent('2');
  });

  it('does not show badge when all alerts are read', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', isRead: true }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
  });

  it('shows 9+ when there are more than 9 unread alerts', async () => {
    const alerts = Array.from({ length: 12 }, (_, i) =>
      makeAlert({ id: `a${i}`, isRead: false }),
    );
    mockGetAlerts.mockResolvedValue(alerts);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    expect(screen.getByTestId('unread-count')).toHaveTextContent('9+');
  });

  it('opens alert list dropdown when clicked', async () => {
    mockGetAlerts.mockResolvedValue([makeAlert()]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));

    expect(screen.getByTestId('alert-list')).toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', async () => {
    mockGetAlerts.mockResolvedValue([makeAlert()]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    expect(screen.getByTestId('alert-list')).toBeInTheDocument();

    fireEvent.mouseDown(document);

    expect(screen.queryByTestId('alert-list')).not.toBeInTheDocument();
  });

  it('marks alert as read when clicked', async () => {
    mockGetAlerts.mockResolvedValue([makeAlert({ id: 'a1', isRead: false })]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    fireEvent.click(screen.getByTestId('alert-item-a1'));

    await waitFor(() => {
      expect(mockMarkAlertRead).toHaveBeenCalledWith('a1');
    });
  });

  it('marks all alerts as read when mark all read is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: false }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    fireEvent.click(screen.getByTestId('mark-all-read'));

    await waitFor(() => {
      expect(mockMarkAllAlertsRead).toHaveBeenCalled();
    });
  });

  it('shows empty state when no alerts', async () => {
    mockGetAlerts.mockResolvedValue([]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));

    expect(screen.getByTestId('no-alerts')).toHaveTextContent('No alerts');
  });

  it('navigates to budget page when alert is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', budgetId: 'budget-123', isRead: true }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    fireEvent.click(screen.getByTestId('alert-item-a1'));

    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('handles API failure gracefully', async () => {
    mockGetAlerts.mockRejectedValue(new Error('Network error'));

    render(<BudgetAlertBadge />);
    await act(async () => {});

    // Should not throw, badge should render without count
    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
  });

  it('shows inline undo when dismiss is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: false }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    expect(screen.getByTestId('alert-item-a1')).toBeInTheDocument();
    expect(screen.getByTestId('alert-item-a2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dismiss-alert-a1'));

    // Alert content replaced with Undo
    expect(screen.queryByTestId('alert-item-a1')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();
    // Other alert remains normal
    expect(screen.getByTestId('alert-item-a2')).toBeInTheDocument();
  });

  it('restores alert when undo is clicked', async () => {
    mockGetAlerts.mockResolvedValue([
      makeAlert({ id: 'a1', isRead: false }),
    ]);

    render(<BudgetAlertBadge />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('alert-badge-button'));
    fireEvent.click(screen.getByTestId('dismiss-alert-a1'));

    // Undo is shown
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();

    // Click undo
    fireEvent.click(screen.getByTestId('undo-dismiss-a1'));

    // Alert is restored
    expect(screen.getByTestId('alert-item-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('undo-dismiss-a1')).not.toBeInTheDocument();
  });
});
