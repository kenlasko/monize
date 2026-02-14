import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import ReconcilePage from './page';
import { TransactionStatus } from '@/types/transaction';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' },
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
  },
}));

const mockGetAll = vi.fn();
const mockGetReconciliationData = vi.fn();
const mockBulkReconcile = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getReconciliationData: (...args: any[]) => mockGetReconciliationData(...args),
    bulkReconcile: (...args: any[]) => mockBulkReconcile(...args),
  },
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: (code: string) => code === 'CAD' ? 'CA$' : '$',
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number, _currency?: string) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
    defaultCurrency: 'USD',
  }),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, isLoading, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled || isLoading} data-loading={isLoading} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/ui/Input', () => ({
  Input: ({ label, ...rest }: any) => (
    <div>
      <label>{label}</label>
      <input aria-label={label} {...rest} />
    </div>
  ),
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label, value, onChange, ...rest }: any) => (
    <div>
      <label>{label}</label>
      <input
        aria-label={label}
        type="number"
        value={value ?? ''}
        onChange={(e: any) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        {...rest}
      />
    </div>
  ),
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({ label, options, value, onChange }: any) => (
    <div>
      <label>{label}</label>
      <select aria-label={label} value={value} onChange={onChange}>
        {options?.map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  ),
}));

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/reconcile',
  useSearchParams: () => new URLSearchParams(),
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Checking', accountType: 'CHEQUING', accountSubType: null, currencyCode: 'USD', currentBalance: 1500, isClosed: false },
  { id: 'acc-2', name: 'Visa', accountType: 'CREDIT_CARD', accountSubType: null, currencyCode: 'USD', currentBalance: -500, isClosed: false },
  { id: 'acc-3', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 10000, isClosed: false },
  { id: 'acc-4', name: 'Old Savings', accountType: 'SAVINGS', accountSubType: null, currencyCode: 'USD', currentBalance: 0, isClosed: true },
];

const mockTransactions = [
  { id: 'tx-1', transactionDate: '2026-02-01', payee: { name: 'Grocery Store' }, payeeName: null, category: { name: 'Food' }, amount: -50.25, status: TransactionStatus.CLEARED },
  { id: 'tx-2', transactionDate: '2026-02-05', payee: null, payeeName: 'Salary', category: { name: 'Income' }, amount: 3000, status: TransactionStatus.UNRECONCILED },
  { id: 'tx-3', transactionDate: '2026-02-10', payee: { name: 'Electric Co' }, payeeName: null, category: null, amount: -120.50, status: TransactionStatus.CLEARED },
];

const mockReconciliationData = {
  transactions: mockTransactions,
  reconciledBalance: 1000,
  clearedBalance: 1200,
  difference: 300,
};

describe('ReconcilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue(mockAccounts);
    mockGetReconciliationData.mockResolvedValue(mockReconciliationData);
    mockBulkReconcile.mockResolvedValue({ reconciled: 2 });
  });

  describe('Setup Step', () => {
    it('renders the page header with title', async () => {
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByText('Reconcile Account')).toBeInTheDocument();
      });
    });

    it('renders within page layout', async () => {
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders the setup form fields', async () => {
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
        expect(screen.getByLabelText('Statement Date')).toBeInTheDocument();
        expect(screen.getByLabelText('Statement Ending Balance')).toBeInTheDocument();
      });
    });

    it('filters out investment brokerage and closed accounts', async () => {
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });
      expect(screen.getByText(/Checking/)).toBeInTheDocument();
      expect(screen.getByText(/Visa/)).toBeInTheDocument();
      expect(screen.queryByText(/Brokerage/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Old Savings/)).not.toBeInTheDocument();
    });

    it('shows liability note for credit card accounts', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      expect(screen.getByText(/Liability accounts typically have a negative balance/)).toBeInTheDocument();
    });

    it('does not show liability note for non-liability accounts', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      expect(screen.queryByText(/Liability accounts typically/)).not.toBeInTheDocument();
    });

    it('navigates to accounts on cancel', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Cancel'));
      expect(mockRouterPush).toHaveBeenCalledWith('/accounts');
    });

    it('disables start button when required fields are empty', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      const startButtons = screen.getAllByText('Start Reconciliation');
      const button = startButtons.find(el => el.tagName === 'BUTTON');
      expect(button).toBeDisabled();
    });
  });

  describe('Reconcile Step', () => {
    async function advanceToReconcileStep() {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      const startButtons = screen.getAllByText('Start Reconciliation');
      fireEvent.click(startButtons.find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Statement Balance')).toBeInTheDocument());
    }

    it('loads reconciliation data and shows summary bar', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Statement Balance')).toBeInTheDocument();
      expect(screen.getByText('Reconciled Balance')).toBeInTheDocument();
      expect(screen.getByText('Difference')).toBeInTheDocument();
    });

    it('pre-selects cleared transactions', async () => {
      await advanceToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked(); // tx-1 CLEARED
      expect(checkboxes[1]).not.toBeChecked(); // tx-2 UNRECONCILED
      expect(checkboxes[2]).toBeChecked(); // tx-3 CLEARED
    });

    it('renders transaction payee names', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      expect(screen.getByText('Salary')).toBeInTheDocument();
      expect(screen.getByText('Electric Co')).toBeInTheDocument();
    });

    it('shows transaction count in header', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Unreconciled Transactions (3)')).toBeInTheDocument();
    });

    it('toggles transaction selection via checkbox', async () => {
      await advanceToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      expect(checkboxes[0]).not.toBeChecked();
      fireEvent.click(checkboxes[0]);
      expect(checkboxes[0]).toBeChecked();
    });

    it('toggles selection via row click', async () => {
      await advanceToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(screen.getByText('Salary').closest('tr')!);
      expect(checkboxes[1]).toBeChecked();
    });

    it('Select All selects all transactions', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Select All'));
      screen.getAllByRole('checkbox').forEach(cb => expect(cb).toBeChecked());
    });

    it('Select None deselects all transactions', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Select None'));
      screen.getAllByRole('checkbox').forEach(cb => expect(cb).not.toBeChecked());
    });

    it('calculates difference correctly', async () => {
      // statementBalance=1500, reconciledBalance=1000
      // cleared: tx-1(-50.25) + tx-3(-120.50) = -170.75
      // newBalance = 1000 + (-170.75) = 829.25
      // difference = 1500 - 829.25 = 670.75
      await advanceToReconcileStep();
      expect(screen.getByText('$670.75')).toBeInTheDocument();
    });

    it('disables Finish button when difference exceeds tolerance', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Finish Reconciliation')).toBeDisabled();
    });

    it('cancel returns to setup step', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => {
        const btns = screen.getAllByText('Start Reconciliation');
        expect(btns.length).toBeGreaterThan(0);
      });
    });

    it('shows empty state when no transactions', async () => {
      mockGetReconciliationData.mockResolvedValue({ ...mockReconciliationData, transactions: [] });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => {
        expect(screen.getByText('No unreconciled transactions found for this period.')).toBeInTheDocument();
      });
    });

    it('displays transaction status indicators', async () => {
      await advanceToReconcileStep();
      expect(screen.getAllByTitle('Cleared').length).toBe(2);
      expect(screen.getByTitle('Unreconciled')).toBeInTheDocument();
    });
  });

  describe('Complete Step', () => {
    async function setupFinishable() {
      mockGetReconciliationData.mockResolvedValue({
        transactions: [{
          id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
          payeeName: null, category: null, amount: 500, status: TransactionStatus.CLEARED,
        }],
        reconciledBalance: 1000, clearedBalance: 1500, difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument());
    }

    it('shows completion message after successful reconciliation', async () => {
      await setupFinishable();
      expect(screen.getByText(/successfully reconciled/i)).toBeInTheDocument();
    });

    it('provides Back to Accounts navigation', async () => {
      await setupFinishable();
      fireEvent.click(screen.getByText('Back to Accounts'));
      expect(mockRouterPush).toHaveBeenCalledWith('/accounts');
    });

    it('resets to setup step on Reconcile Another Account', async () => {
      await setupFinishable();
      fireEvent.click(screen.getByText('Reconcile Another Account'));
      await waitFor(() => {
        expect(screen.getAllByText('Start Reconciliation').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when accounts fail to load', async () => {
      const toast = await import('react-hot-toast');
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to load accounts');
      });
    });

    it('shows error toast when reconciliation data fails', async () => {
      const toast = await import('react-hot-toast');
      mockGetReconciliationData.mockRejectedValue(new Error('Server error'));
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to load reconciliation data');
      });
    });

    it('shows error toast when finish reconciliation fails', async () => {
      const toast = await import('react-hot-toast');
      mockBulkReconcile.mockRejectedValue(new Error('Failed'));
      mockGetReconciliationData.mockResolvedValue({
        transactions: [{
          id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
          payeeName: null, category: null, amount: 500, status: TransactionStatus.CLEARED,
        }],
        reconciledBalance: 1000, clearedBalance: 1500, difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByLabelText('Account')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to reconcile transactions');
      });
    });
  });
});
