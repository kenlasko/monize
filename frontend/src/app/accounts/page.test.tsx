import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import AccountsPage from './page';

// Module-level state for controlling form modal in tests
const formModalState = {
  showForm: false,
  editingItem: null as any,
  isEditing: false,
};

// Captured onSubmit from AccountForm for testing
let capturedOnSubmit: ((data: any) => Promise<void>) | null = null;

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock next/dynamic - expose onSubmit/onCancel for form testing
vi.mock('next/dynamic', () => ({
  default: () => (props: any) => {
    capturedOnSubmit = props.onSubmit ?? null;
    return (
      <div data-testid="account-form">
        <button
          data-testid="submit-form"
          onClick={() => props.onSubmit && props.onSubmit({})}
        >
          Submit
        </button>
      </div>
    );
  },
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

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
  showErrorToast: vi.fn(),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: {
          id: 'test-user-id',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          role: 'user',
          hasPassword: true,
        },
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

// Mock accounts API
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

// Mock investments API
const mockGetPortfolioSummary = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
  },
}));

// Mock child components
vi.mock('@/components/accounts/AccountList', () => ({
  AccountList: ({ accounts, onEdit }: any) => (
    <div data-testid="account-list">
      {accounts.map((a: any) => (
        <div key={a.id} data-testid={`account-${a.id}`}>
          {a.name}
          <button data-testid={`edit-${a.id}`} onClick={() => onEdit(a)}>Edit</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { accounts: null, money: null, checkmark: null, cross: null },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions}
    </div>
  ),
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: formModalState.showForm,
    editingItem: formModalState.editingItem,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: formModalState.isEditing,
    modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (val: number) => val,
    defaultCurrency: 'USD',
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 5000, isClosed: false, canDelete: true },
  { id: 'acc-2', name: 'Savings', accountType: 'SAVINGS', accountSubType: null, currencyCode: 'USD', currentBalance: 10000, isClosed: false, canDelete: true },
  { id: 'acc-3', name: 'Credit Card', accountType: 'CREDIT_CARD', accountSubType: null, currencyCode: 'USD', currentBalance: -2000, isClosed: false, canDelete: false },
  { id: 'acc-4', name: 'Old Account', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 0, isClosed: true, canDelete: true },
  { id: 'acc-5', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false },
];

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    // Reset form modal state
    formModalState.showForm = false;
    formModalState.editingItem = null;
    formModalState.isEditing = false;
    capturedOnSubmit = null;
  });

  it('renders the page header with title', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('Accounts')).toBeInTheDocument();
    });
  });

  it('renders the page subtitle', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage your bank accounts/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Active Accounts')).toBeInTheDocument();
    });
  });

  it('shows loading spinner while data is loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('renders + New Account button', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Account')).toBeInTheDocument();
    });
  });

  it('renders account list after data loads', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-list')).toBeInTheDocument();
    });
  });

  it('displays all accounts in the account list', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('Checking')).toBeInTheDocument();
      expect(screen.getByText('Savings')).toBeInTheDocument();
      expect(screen.getByText('Credit Card')).toBeInTheDocument();
    });
  });

  it('calls getAll with true to include closed accounts', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(true);
    });
  });

  it('fetches portfolio summary on mount', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
    });
  });

  it('shows correct account count for active accounts', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      // 4 active accounts (excluding the closed one)
      expect(screen.getByTestId('summary-Total Active Accounts')).toHaveTextContent('4');
    });
  });

  it('calculates net worth correctly (assets minus liabilities)', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      // Assets: 5000 + 10000 + 0 (brokerage) = 15000
      // Liabilities: 2000 (credit card abs)
      // Net worth: 15000 - 2000 = 13000
      expect(screen.getByTestId('summary-Net Worth')).toHaveTextContent('$13000.00');
    });
  });

  it('calculates total assets correctly', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$15000.00');
    });
  });

  it('calculates total liabilities correctly', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Liabilities')).toHaveTextContent('$2000.00');
    });
  });

  it('handles API error gracefully', async () => {
    const { showErrorToast } = await import('@/lib/errors');
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    render(<AccountsPage />);
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(expect.any(Error), 'Failed to load accounts');
    });
  });

  it('uses brokerage market values from portfolio summary (holdings only, cash in linked account)', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'acc-5', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdingsByAccount: [
        { accountId: 'acc-5', totalMarketValue: 50000, cashBalance: 5000 },
      ],
    });
    render(<AccountsPage />);
    await waitFor(() => {
      // Brokerage value: 50000 (holdings only; cash balance is in the linked INVESTMENT_CASH account)
      expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$50000.00');
    });
  });

  it('counts linked brokerage/cash pair as a single account in the Total Active Accounts widget', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 5000, isClosed: false, canDelete: true, linkedAccountId: null },
      { id: 'acc-brokerage', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false, linkedAccountId: 'acc-cash' },
      { id: 'acc-cash', name: 'Brokerage Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', currencyCode: 'USD', currentBalance: 5000, isClosed: false, canDelete: false, linkedAccountId: 'acc-brokerage' },
    ]);
    render(<AccountsPage />);
    await waitFor(() => {
      // 1 chequing + 1 linked brokerage/cash pair = 2, not 3.
      expect(screen.getByTestId('summary-Total Active Accounts')).toHaveTextContent('2');
    });
  });

  it('does not double-count investment cash in brokerage and linked cash account', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'acc-brokerage', name: 'My Investments - Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false, linkedAccountId: 'acc-cash' },
      { id: 'acc-cash', name: 'My Investments - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', currencyCode: 'USD', currentBalance: 5000, isClosed: false, canDelete: false, linkedAccountId: 'acc-brokerage' },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdingsByAccount: [
        { accountId: 'acc-brokerage', totalMarketValue: 50000, cashBalance: 5000 },
      ],
    });
    render(<AccountsPage />);
    await waitFor(() => {
      // Total should be 50000 (holdings) + 5000 (cash account) = 55000
      // NOT 55000 (holdings+cash in brokerage) + 5000 (cash account) = 60000 (double-counted)
      expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$55000.00');
      expect(screen.getByTestId('summary-Net Worth')).toHaveTextContent('$55000.00');
    });
  });

  it('handles portfolio summary fetch failure gracefully', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    mockGetPortfolioSummary.mockRejectedValue(new Error('API error'));
    render(<AccountsPage />);
    // Page should still render without crashing
    await waitFor(() => {
      expect(screen.getByTestId('account-list')).toBeInTheDocument();
    });
  });

  it('renders account form modal when showForm is true', async () => {
    formModalState.showForm = true;
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-form')).toBeInTheDocument();
    });
  });

  it('shows New Account heading in modal when creating', async () => {
    formModalState.showForm = true;
    formModalState.isEditing = false;
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('New Account')).toBeInTheDocument();
    });
  });

  it('shows Edit Account heading in modal when editing', async () => {
    formModalState.showForm = true;
    formModalState.editingItem = mockAccounts[0];
    formModalState.isEditing = true;
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('Edit Account')).toBeInTheDocument();
    });
  });

  describe('handleFormSubmit - create account', () => {
    beforeEach(() => {
      formModalState.showForm = true;
      formModalState.editingItem = null;
      formModalState.isEditing = false;
    });

    it('calls accountsApi.create when creating a new account', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc', name: 'Test' });
      mockGetAll.mockResolvedValue([]);
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ name: 'Test Account', accountType: 'CHECKING' });
      });
      expect(mockCreate).toHaveBeenCalled();
    });

    it('calls accountsApi.create with cleaned data (strips undefined fields)', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({
          name: 'Test',
          accountType: 'CHECKING',
          openingBalance: '',
          creditLimit: undefined,
          interestRate: NaN,
        });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg).not.toHaveProperty('interestRate');
    });

    it('passes opening balance as-is for CREDIT_CARD when creating', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', openingBalance: -1000 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(-1000);
    });

    it('passes opening balance as-is for LINE_OF_CREDIT when creating', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'LINE_OF_CREDIT', openingBalance: -500 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(-500);
    });

    it('preserves positive opening balance for CREDIT_CARD when creating (no auto-negation)', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', openingBalance: 250 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(250);
    });

    it('preserves positive opening balance for LINE_OF_CREDIT when creating', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'LINE_OF_CREDIT', openingBalance: 750 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(750);
    });

    it('preserves negative opening balance for CHEQUING (overdrawn account)', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CHEQUING', openingBalance: -150 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(-150);
    });

    it('does NOT negate opening balance for LOAN/MORTGAGE (backend handles it)', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'LOAN', openingBalance: 10000 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(10000);
    });

    it('passes zero opening balance as-is for CREDIT_CARD', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', openingBalance: 0 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(0);
    });

    it('preserves openingBalance when it is explicitly 0', async () => {
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CHECKING', openingBalance: 0 });
      });
      const callArg = mockCreate.mock.calls[0][0];
      expect(callArg.openingBalance).toBe(0);
    });

    it('shows success toast after creating account', async () => {
      const toast = await import('react-hot-toast');
      mockCreate.mockResolvedValue({ id: 'new-acc' });
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CHECKING' });
      });
      expect(toast.default.success).toHaveBeenCalledWith('Account created successfully');
    });

    it('shows error toast and rethrows on create failure', async () => {
      const { showErrorToast } = await import('@/lib/errors');
      mockCreate.mockRejectedValue(new Error('Create failed'));
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await expect(
        act(async () => { await capturedOnSubmit!({ accountType: 'CHECKING' }); })
      ).rejects.toThrow();
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  describe('handleFormSubmit - update account', () => {
    beforeEach(() => {
      formModalState.showForm = true;
      formModalState.editingItem = mockAccounts[0];
      formModalState.isEditing = true;
    });

    it('calls accountsApi.update when editing an existing account', async () => {
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ name: 'Updated Name', accountType: 'CHECKING' });
      });
      expect(mockUpdate).toHaveBeenCalledWith(mockAccounts[0].id, expect.any(Object));
    });

    it('shows success toast after updating account', async () => {
      const toast = await import('react-hot-toast');
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ name: 'Updated', accountType: 'CHECKING' });
      });
      expect(toast.default.success).toHaveBeenCalledWith('Account updated successfully');
    });

    it('passes opening balance as-is for CREDIT_CARD on update', async () => {
      formModalState.editingItem = { ...mockAccounts[2], id: 'cc-1' };
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', openingBalance: -2000 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.openingBalance).toBe(-2000);
    });

    it('negates positive opening balance for LOAN on update', async () => {
      formModalState.editingItem = { id: 'loan-1', accountType: 'LOAN' };
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'LOAN', openingBalance: 50000 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.openingBalance).toBe(-50000);
    });

    it('negates positive opening balance for MORTGAGE on update', async () => {
      formModalState.editingItem = { id: 'mort-1', accountType: 'MORTGAGE' };
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'MORTGAGE', openingBalance: 250000 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.openingBalance).toBe(-250000);
    });

    it('passes opening balance as-is for LINE_OF_CREDIT on update', async () => {
      formModalState.editingItem = { id: 'loc-1', accountType: 'LINE_OF_CREDIT' };
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'LINE_OF_CREDIT', openingBalance: -3000 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.openingBalance).toBe(-3000);
    });

    it('preserves positive opening balance for CREDIT_CARD on update', async () => {
      formModalState.editingItem = { id: 'cc-2', accountType: 'CREDIT_CARD' };
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', openingBalance: 100 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.openingBalance).toBe(100);
    });

    it('preserves creditLimit value when provided', async () => {
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', creditLimit: 5000 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.creditLimit).toBe(5000);
    });

    it('preserves creditLimit when it is 0', async () => {
      mockUpdate.mockResolvedValue({});
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await act(async () => {
        await capturedOnSubmit!({ accountType: 'CREDIT_CARD', creditLimit: 0 });
      });
      const callArg = mockUpdate.mock.calls[0][1];
      expect(callArg.creditLimit).toBe(0);
    });

    it('shows error toast and rethrows on update failure', async () => {
      const { showErrorToast } = await import('@/lib/errors');
      mockUpdate.mockRejectedValue(new Error('Update failed'));
      render(<AccountsPage />);
      await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
      await expect(
        act(async () => { await capturedOnSubmit!({ accountType: 'CHECKING' }); })
      ).rejects.toThrow();
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  describe('calculateSummary - edge cases', () => {
    it('uses futureTransactionsSum when present', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'acc-x', name: 'Checking', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 1000, futureTransactionsSum: 500, isClosed: false },
      ]);
      render(<AccountsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$1500.00');
      });
    });

    it('handles MORTGAGE as a liability type', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'acc-m', name: 'Mortgage', accountType: 'MORTGAGE', accountSubType: null, currencyCode: 'USD', currentBalance: -200000, isClosed: false },
      ]);
      render(<AccountsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Liabilities')).toHaveTextContent('$200000.00');
      });
    });

    it('handles LOAN as a liability type', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'acc-l', name: 'Car Loan', accountType: 'LOAN', accountSubType: null, currencyCode: 'USD', currentBalance: -15000, isClosed: false },
      ]);
      render(<AccountsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Liabilities')).toHaveTextContent('$15000.00');
      });
    });

    it('handles brokerage with no portfolio summary (falls back to 0)', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'acc-b', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 9999, isClosed: false },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(null);
      render(<AccountsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$0.00');
      });
    });
  });
});
