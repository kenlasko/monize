import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import { render, screen, waitFor, fireEvent, within, act } from '@/test/render';
import ReconcilePage from './page';
import { TransactionStatus } from '@/types/transaction';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

const mockGetAll = vi.fn();
const mockGetDailyBalances = vi.fn();
const mockGetReconciliationData = vi.fn();
const mockBulkReconcile = vi.fn();
const mockScheduledGetAll = vi.fn();
const mockDelete = vi.fn();
const mockDeleteTransfer = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getDailyBalances: (...args: any[]) => mockGetDailyBalances(...args),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockScheduledGetAll(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getReconciliationData: (...args: any[]) => mockGetReconciliationData(...args),
    bulkReconcile: (...args: any[]) => mockBulkReconcile(...args),
    delete: (...args: any[]) => mockDelete(...args),
    deleteTransfer: (...args: any[]) => mockDeleteTransfer(...args),
    updateStatus: (...args: any[]) => mockUpdateStatus(...args),
  },
}));

// The transaction form is loaded through next/dynamic; render a stand-in that
// exposes the success callback so the page's reload path can be driven.
vi.mock('next/dynamic', () => ({
  default: () => {
    const DynamicTransactionForm = (props: any) => (
      <div data-testid="reconcile-transaction-form">
        <span data-testid="form-mode">{props.transaction ? props.transaction.id : 'new'}</span>
        <span data-testid="form-default-account">{props.defaultAccountId}</span>
        <button data-testid="form-succeed" onClick={() => props.onSuccess?.()}>
          Saved
        </button>
      </div>
    );
    return DynamicTransactionForm;
  },
}));

vi.mock('@/lib/format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  getCurrencySymbol: (code: string) => code === 'CAD' ? 'CA$' : '$',
  getDecimalPlacesForCurrency: () => 2,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (val: number, _currency?: string) => `$${val.toFixed(2)}`,
      formatNumber: (val: number) => val.toString(),
      defaultCurrency: 'USD',
    }),
  };
});
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
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/reconcile',
  useSearchParams: () => mockSearchParams,
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Checking', accountType: 'CHEQUING', accountSubType: null, currencyCode: 'USD', currentBalance: 1500, isClosed: false },
  { id: 'acc-2', name: 'Visa', accountType: 'CREDIT_CARD', accountSubType: null, currencyCode: 'USD', currentBalance: -500, isClosed: false },
  { id: 'acc-3', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 10000, isClosed: false },
  { id: 'acc-4', name: 'Old Savings', accountType: 'SAVINGS', accountSubType: null, currencyCode: 'USD', currentBalance: 0, isClosed: true },
  { id: 'acc-5', name: 'Car Loan', accountType: 'LOAN', accountSubType: null, currencyCode: 'USD', currentBalance: -8000, isClosed: false },
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
    mockSearchParams = new URLSearchParams();
    mockGetAll.mockResolvedValue(mockAccounts);
    // No ledger balance by default, so the statement balance stays what each
    // test types.
    mockGetDailyBalances.mockResolvedValue([]);
    mockGetReconciliationData.mockResolvedValue(mockReconciliationData);
    mockBulkReconcile.mockResolvedValue({ reconciled: 2 });
    mockScheduledGetAll.mockResolvedValue([]);
    mockDelete.mockResolvedValue(undefined);
    mockDeleteTransfer.mockResolvedValue(undefined);
    mockUpdateStatus.mockResolvedValue(undefined);
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
        expect(screen.getByText(/Checking/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Visa/)).toBeInTheDocument();
      expect(screen.queryByText(/Brokerage/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Old Savings/)).not.toBeInTheDocument();
    });

    it("labels each account option in that account's own currency", async () => {
      // The option labels once went through the selected account's currency, so
      // choosing a CAD account relabelled every USD balance in the list as CAD.
      mockGetAll.mockResolvedValue([
        ...mockAccounts,
        { id: 'acc-6', name: 'Loonie Chequing', accountType: 'CHEQUING', accountSubType: null, currencyCode: 'CAD', currentBalance: 250, isClosed: false },
      ]);
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Loonie Chequing/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-6' } });

      expect(screen.getByRole('option', { name: 'Loonie Chequing ($250.00 CAD)' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Checking ($1500.00)' })).toBeInTheDocument();
    });

    it('lists favourites first, then every other account A-Z', async () => {
      mockGetAll.mockResolvedValue([
        { ...mockAccounts[0], id: 'z', name: 'Zeta', isFavourite: false, favouriteSortOrder: 0 },
        { ...mockAccounts[0], id: 'a', name: 'Alpha', isFavourite: false, favouriteSortOrder: 0 },
        { ...mockAccounts[0], id: 'f2', name: 'Fav Two', isFavourite: true, favouriteSortOrder: 2 },
        { ...mockAccounts[0], id: 'f1', name: 'Fav One', isFavourite: true, favouriteSortOrder: 1 },
      ]);
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Zeta/)).toBeInTheDocument());
      const values = Array.from(
        (screen.getByLabelText('Account') as HTMLSelectElement).options,
      ).map((o) => o.value);
      expect(values).toEqual(['', 'f1', 'f2', '__separator__', 'a', 'z']);
    });

    describe('statement ending balance prefill', () => {
      const dateInput = () => screen.getByLabelText('Statement Date') as HTMLInputElement;
      const balanceInput = () =>
        screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;

      it("fills in the account's ledger balance at the statement date", async () => {
        mockGetDailyBalances.mockImplementation(async (params: any) => [
          { date: params.startDate, balance: 1234.56, accountId: params.accountIds, currencyCode: 'USD' },
        ]);
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
        expect(dateInput()).toBeInTheDocument();
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
        });
        expect(mockGetDailyBalances).toHaveBeenCalledWith({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: mockGetDailyBalances.mock.calls[0][0].startDate,
          accountIds: 'acc-1',
        });
        expect(Number(balanceInput().value)).toBe(1234.56);

        // Still the user's to change.
        fireEvent.change(balanceInput(), { target: { value: '1200' } });
        expect(Number(balanceInput().value)).toBe(1200);
      });

      it('fills in a liability balance as the ledger holds it, without re-signing it', async () => {
        mockGetDailyBalances.mockImplementation(async (params: any) => [
          { date: params.startDate, balance: 25, accountId: params.accountIds, currencyCode: 'USD' },
        ]);
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
        });
        // A card in credit: the auto-negation is for typed entries only.
        expect(Number(balanceInput().value)).toBe(25);
      });

      it('fetches again for the new date when the statement date changes', async () => {
        mockGetDailyBalances.mockImplementation(async (params: any) => [
          { date: params.startDate, balance: params.startDate === '2026-09-30' ? 900 : 1000, accountId: params.accountIds, currencyCode: 'USD' },
        ]);
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
        });
        expect(Number(balanceInput().value)).toBe(1000);

        await act(async () => {
          fireEvent.change(dateInput(), { target: { value: '2026-09-30' } });
          fireEvent.blur(dateInput());
        });
        expect(mockGetDailyBalances).toHaveBeenLastCalledWith({
          startDate: '2026-09-30',
          endDate: '2026-09-30',
          accountIds: 'acc-1',
        });
        expect(Number(balanceInput().value)).toBe(900);
      });

      it('never overwrites a figure the user typed while the lookup was in flight', async () => {
        let resolve: (value: unknown) => void = () => {};
        mockGetDailyBalances.mockImplementation(
          (params: any) =>
            new Promise((r) => {
              resolve = () => r([{ date: params.startDate, balance: 1000, accountId: params.accountIds, currencyCode: 'USD' }]);
            }),
        );
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
        fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
        fireEvent.change(balanceInput(), { target: { value: '1500' } });
        await act(async () => {
          resolve(undefined);
        });
        expect(Number(balanceInput().value)).toBe(1500);
      });

      it('fills in the balance for an account arriving from the accounts list', async () => {
        mockSearchParams = new URLSearchParams('accountId=acc-1');
        mockGetDailyBalances.mockImplementation(async (params: any) => [
          { date: params.startDate, balance: 987.6543, accountId: params.accountIds, currencyCode: 'USD' },
        ]);
        await act(async () => {
          render(<ReconcilePage />);
        });
        await waitFor(() => expect(Number(balanceInput().value)).toBe(987.65));
        expect(mockGetDailyBalances).toHaveBeenCalledWith(
          expect.objectContaining({ accountIds: 'acc-1' }),
        );
      });

      it('fills in the balance again for the next account after a reconciliation', async () => {
        mockGetDailyBalances.mockImplementation(async (params: any) => [
          { date: params.startDate, balance: 500, accountId: params.accountIds, currencyCode: 'USD' },
        ]);
        mockGetReconciliationData.mockResolvedValue({
          transactions: [{
            id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
            payeeName: null, category: null, amount: 500, status: TransactionStatus.UNRECONCILED,
          }],
          reconciledBalance: 0, clearedBalance: 0, difference: 500,
        });
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
        });
        // The pre-filled balance and the pre-ticked row already agree.
        await act(async () => {
          fireEvent.click(screen.getAllByText('Start Reconciliation').find((el) => el.tagName === 'BUTTON')!);
        });
        await act(async () => {
          fireEvent.click(screen.getByText('Finish Reconciliation'));
        });
        await act(async () => {
          fireEvent.click(screen.getByText('Reconcile Another Account'));
        });
        expect(Number(balanceInput().value)).toBe(500);
      });

      it('leaves the field empty when the lookup fails', async () => {
        mockGetDailyBalances.mockRejectedValue(new Error('down'));
        render(<ReconcilePage />);
        await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
        });
        expect(balanceInput().value).toBe('');
      });
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

    it('stores a typed "-0" as plain zero, never negative zero', async () => {
      // Number("-0") is negative zero, and Intl formats -0 with a leading
      // minus -- so an unnormalized entry would print "-$0.00" across the
      // reconcile step and go into the request as -0.
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), {
        target: { value: '-0' },
      });
      fireEvent.click(
        screen.getAllByText('Start Reconciliation').find((el) => el.tagName === 'BUTTON')!,
      );
      await waitFor(() => expect(mockGetReconciliationData).toHaveBeenCalled());
      const balanceArg = mockGetReconciliationData.mock.calls[0][2];
      expect(balanceArg).toBe(0);
      expect(Object.is(balanceArg, -0)).toBe(false);
    });
  });

  describe('Reconcile Step', () => {
    async function advanceToReconcileStep() {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      await waitFor(() => {
        const button = screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON');
        expect(button).not.toBeDisabled();
      }, { timeout: 3000 });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Statement Balance')).toBeInTheDocument(), { timeout: 3000 });
    }

    it('keeps Select All and Select None in one non-wrapping group', async () => {
      // The header toolbar wraps on phones; the two selection buttons are
      // halves of one control, so they share a flex group the wrap cannot
      // split -- and Add Transaction is deliberately outside it, free to wrap.
      await advanceToReconcileStep();
      const selectAll = screen.getByText('Select All');
      const selectNone = screen.getByText('Select None');
      expect(selectAll.parentElement).toBe(selectNone.parentElement);
      expect(selectAll.parentElement).not.toContainElement(
        screen.getByText('Add Transaction'),
      );
    });

    it('loads reconciliation data and shows summary bar', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Statement Balance')).toBeInTheDocument();
      expect(screen.getByText('Reconciled Balance')).toBeInTheDocument();
      expect(screen.getByText('Difference')).toBeInTheDocument();
    });

    it('pre-selects every transaction up to the statement date, whatever its status', async () => {
      await advanceToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked(); // tx-1 CLEARED
      expect(checkboxes[1]).toBeChecked(); // tx-2 UNRECONCILED
      expect(checkboxes[2]).toBeChecked(); // tx-3 CLEARED
      expect(screen.getByText('Selected (3)')).toBeInTheDocument();
    });

    it('leaves a row dated after the statement date unticked', async () => {
      mockGetReconciliationData.mockResolvedValue({
        ...mockReconciliationData,
        transactions: [
          ...mockTransactions,
          { id: 'tx-late', transactionDate: '2999-01-01', payee: null, payeeName: 'Later', category: null, amount: -5, status: TransactionStatus.CLEARED },
        ],
      });
      await advanceToReconcileStep();
      expect(within(screen.getByTestId('reconcile-row-tx-late')).getByRole('checkbox')).not.toBeChecked();
      expect(screen.getByText('Selected (3)')).toBeInTheDocument();
    });

    it('keeps the summary bar pinned in view while the list scrolls', async () => {
      await advanceToReconcileStep();
      const summary = screen.getByTestId('reconcile-summary');
      expect(summary).toHaveClass('sticky');
      expect(summary).toContainElement(screen.getByText('Difference'));
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
      expect(checkboxes[1]).not.toBeChecked();
      fireEvent.click(screen.getByText('Salary').closest('tr')!);
      expect(checkboxes[1]).toBeChecked();
    });

    it('Select All selects all transactions', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Select All'));
      await waitFor(() => {
        screen.getAllByRole('checkbox').forEach(cb => expect(cb).toBeChecked());
      }, { timeout: 3000 });
    });

    it('Select None deselects all transactions', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Select None'));
      await waitFor(() => {
        screen.getAllByRole('checkbox').forEach(cb => expect(cb).not.toBeChecked());
      }, { timeout: 3000 });
    });

    it('calculates difference correctly', async () => {
      // statementBalance=1500, reconciledBalance=1000
      // selected: tx-1(-50.25) + tx-2(3000) + tx-3(-120.50) = 2829.25
      // newBalance = 1000 + 2829.25 = 3829.25
      // difference = 1500 - 3829.25 = -2329.25
      await advanceToReconcileStep();
      expect(screen.getByText('$-2329.25')).toBeInTheDocument();
      // Unticking tx-2: newBalance = 829.25, difference = 670.75
      fireEvent.click(screen.getByText('Salary').closest('tr')!);
      expect(screen.getByText('$670.75')).toBeInTheDocument();
    });

    it('disables Finish button when difference exceeds tolerance', async () => {
      await advanceToReconcileStep();
      expect(screen.getByText('Finish Reconciliation')).toBeDisabled();
    });

    const coinReconcile = async (statementBalance: string) => {
      mockGetAll.mockResolvedValue([
        ...mockAccounts,
        { id: 'acc-btc', name: 'Bitcoin Wallet', accountType: 'CRYPTO', accountSubType: null, currencyCode: 'BTC', currentBalance: 0.00747493, isClosed: false },
      ]);
      mockGetReconciliationData.mockResolvedValue({
        transactions: [
          { id: 'tx-buy', transactionDate: '2026-02-01', payee: null, payeeName: 'Exchange', category: null, amount: '0.01249993', status: TransactionStatus.CLEARED },
          { id: 'tx-fee', transactionDate: '2026-02-03', payee: null, payeeName: 'Network fee', category: null, amount: '-0.00002500', status: TransactionStatus.CLEARED },
          { id: 'tx-sale', transactionDate: '2026-02-03', payee: null, payeeName: 'Sale', category: null, amount: '-0.00500000', status: TransactionStatus.CLEARED },
        ],
        reconciledBalance: 0,
        clearedBalance: 0.00747493,
        difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Bitcoin Wallet/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-btc' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: statementBalance } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Statement Balance')).toBeInTheDocument(), { timeout: 3000 });
    };

    it('compares a coin wallet at its own eight places, so a fee-sized difference still blocks Finish', async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      try {
        // The statement omits the 2,500-satoshi fee: 0.00749993 against
        // 0.00747493 cleared. At four places both read 0.0075, and at the old
        // one-cent tolerance the reconciliation could finish unbalanced.
        await coinReconcile('0.00749993');
        expect(screen.getByText('Finish Reconciliation')).toBeDisabled();
      } finally {
        clearCurrencyDecimals();
      }
    });

    it('lets a coin wallet that balances to the satoshi finish', async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      try {
        await coinReconcile('0.00747493');
        // The tolerance is 10 ** -8, one satoshi: a difference of zero is within it.
        expect(screen.getByText('Finish Reconciliation')).not.toBeDisabled();
      } finally {
        clearCurrencyDecimals();
      }
    });

    it('cancel returns to setup step', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => {
        const btns = screen.getAllByText('Start Reconciliation');
        expect(btns.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
    });

    it('shows empty state when no transactions', async () => {
      mockGetReconciliationData.mockResolvedValue({ ...mockReconciliationData, transactions: [] });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => {
        expect(screen.getByText('No unreconciled transactions found for this period.')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('displays each row status through the shared status cell', async () => {
      await advanceToReconcileStep();
      // The reconcile table renders the register's own StatusCellButton, so the
      // dense letters and the click-to-cycle tooltip are the register's.
      expect(screen.getAllByTitle('Click to cycle status').length).toBe(3);
      expect(screen.getAllByText('C').length).toBe(2);
      expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Editing from inside the reconcile step', () => {
    async function advanceToReconcileStep() {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Statement Balance')).toBeInTheDocument(), { timeout: 3000 });
    }

    function rowFor(id: string) {
      return screen.getByTestId(`reconcile-row-${id}`);
    }

    // The inline actions column carries Edit and Delete from `sm` up; the
    // long-press / right-click sheet offers the same handlers and is covered
    // by ReconcileTable's own tests, so the page wiring is exercised once,
    // through the inline path.
    function openRowAction(id: string, label: 'Edit' | 'Delete') {
      fireEvent.click(within(rowFor(id)).getByLabelText(label));
    }

    it('opens a blank form filed against the account being reconciled', async () => {
      await advanceToReconcileStep();
      fireEvent.click(screen.getByText('Add Transaction'));
      expect(screen.getByTestId('form-mode')).toHaveTextContent('new');
      expect(screen.getByTestId('form-default-account')).toHaveTextContent('acc-1');
    });

    it('opens the clicked row for editing', async () => {
      await advanceToReconcileStep();
      openRowAction('tx-2', 'Edit');
      expect(screen.getByTestId('form-mode')).toHaveTextContent('tx-2');
    });

    it('reloads the list after a save', async () => {
      await advanceToReconcileStep();
      mockGetReconciliationData.mockClear();
      fireEvent.click(screen.getByText('Add Transaction'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('form-succeed'));
      });
      expect(mockGetReconciliationData).toHaveBeenCalledWith('acc-1', expect.any(String), 1500);
      expect(screen.queryByTestId('reconcile-transaction-form')).not.toBeInTheDocument();
    });

    it('keeps an unticked row unticked across the reload, whatever its status', async () => {
      await advanceToReconcileStep();
      // tx-1 is CLEARED and ticked by default; the user takes it off.
      fireEvent.click(rowFor('tx-1'));
      expect(screen.getByText('Selected (2)')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Add Transaction'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('form-succeed'));
      });
      await waitFor(() => expect(screen.getByText('Selected (2)')).toBeInTheDocument());
      expect(within(rowFor('tx-1')).getByRole('checkbox')).not.toBeChecked();
    });

    it('ticks a row that newly appears on the statement after a save', async () => {
      await advanceToReconcileStep();
      fireEvent.click(rowFor('tx-2'));
      expect(screen.getByText('Selected (2)')).toBeInTheDocument();

      mockGetReconciliationData.mockResolvedValue({
        ...mockReconciliationData,
        transactions: [
          ...mockTransactions,
          { id: 'tx-new', transactionDate: '2026-02-12', payee: null, payeeName: 'Added', category: null, amount: -10, status: TransactionStatus.UNRECONCILED },
        ],
      });
      fireEvent.click(screen.getByText('Add Transaction'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('form-succeed'));
      });
      await waitFor(() => expect(screen.getByText('Selected (3)')).toBeInTheDocument());
      expect(within(rowFor('tx-new')).getByRole('checkbox')).toBeChecked();
      expect(within(rowFor('tx-2')).getByRole('checkbox')).not.toBeChecked();
    });

    it('drops a row that is no longer listed from the selection', async () => {
      // A phantom id left in the set would keep contributing its amount to the
      // selected total, so the difference would never reach zero and the user
      // could not finish.
      await advanceToReconcileStep();
      expect(screen.getByText('Selected (3)')).toBeInTheDocument();

      mockGetReconciliationData.mockResolvedValue({
        ...mockReconciliationData,
        transactions: mockTransactions.filter((t) => t.id !== 'tx-1'),
      });
      openRowAction('tx-1', 'Delete');
      await act(async () => {
        fireEvent.click(screen.getByText('Delete'));
      });
      await waitFor(() => expect(screen.getByText('Selected (2)')).toBeInTheDocument());
    });

    it('deletes a plain transaction through the plain delete', async () => {
      await advanceToReconcileStep();
      openRowAction('tx-1', 'Delete');
      await act(async () => {
        fireEvent.click(screen.getByText('Delete'));
      });
      expect(mockDelete).toHaveBeenCalledWith('tx-1');
      expect(mockDeleteTransfer).not.toHaveBeenCalled();
    });

    it('deletes a transfer through the transfer delete, so both legs go', async () => {
      // Calling the plain delete on a transfer leaves the counterpart behind,
      // holding money that no longer has a source.
      mockGetReconciliationData.mockResolvedValue({
        ...mockReconciliationData,
        transactions: [{ ...mockTransactions[0], isTransfer: true }],
      });
      await advanceToReconcileStep();
      openRowAction('tx-1', 'Delete');
      await act(async () => {
        fireEvent.click(screen.getByText('Delete'));
      });
      expect(mockDeleteTransfer).toHaveBeenCalledWith('tx-1');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('asks before deleting', async () => {
      await advanceToReconcileStep();
      openRowAction('tx-1', 'Delete');
      expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('cycles a row status and reloads', async () => {
      await advanceToReconcileStep();
      mockGetReconciliationData.mockClear();
      await act(async () => {
        fireEvent.click(within(rowFor('tx-2')).getByTitle('Click to cycle status'));
      });
      expect(mockUpdateStatus).toHaveBeenCalledWith('tx-2', 'CLEARED');
      expect(mockGetReconciliationData).toHaveBeenCalled();
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
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument(), { timeout: 3000 });
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
      }, { timeout: 3000 });
    });
  });

  describe('Liability Account Auto-Negation', () => {
    it('auto-negates a positive statement balance for a credit card account', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '500' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(Number(input.value)).toBe(-500);
    });

    it('leaves a negative statement balance unchanged for a liability account', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '-500' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(Number(input.value)).toBe(-500);
    });

    it('does not auto-negate for a non-liability account', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(Number(input.value)).toBe(1500);
    });

    it('passes undefined through without negating for liability account', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('does not render an override checkbox for liability accounts', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      expect(screen.queryByLabelText(/Allow positive balance/i)).not.toBeInTheDocument();
    });

    it('respects an explicit sign flip from negative to positive', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      // First entry: positive value gets auto-negated
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '500' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(Number(input.value)).toBe(-500);
      // User flips sign back to positive (same absolute value) -- respect it
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '500' } });
      expect(Number(input.value)).toBe(500);
    });

    it('auto-negates again when the absolute value changes', async () => {
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '500' } });
      // Different absolute value -- auto-negate kicks in again
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '750' } });
      const input = screen.getByLabelText('Statement Ending Balance') as HTMLInputElement;
      expect(Number(input.value)).toBe(-750);
    });

    it('passes no account-specific placeholder -- the field keeps its neutral default', async () => {
      // The liability "-0.00" placeholder read as a broken value, and the
      // auto-negation above already owns the sign, so no account type gets a
      // placeholder of its own (CurrencyInput's built-in "0.00" applies).
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument());
      for (const accountId of ['acc-1', 'acc-2']) {
        fireEvent.change(screen.getByLabelText('Account'), { target: { value: accountId } });
        expect(screen.getByLabelText('Statement Ending Balance')).not.toHaveAttribute(
          'placeholder',
        );
      }
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when accounts fail to load', async () => {
      const toast = await import('react-hot-toast');
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to load accounts');
      }, { timeout: 3000 });
    });

    it('shows error toast when reconciliation data fails', async () => {
      const toast = await import('react-hot-toast');
      mockGetReconciliationData.mockRejectedValue(new Error('Server error'));
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to load reconciliation data');
      }, { timeout: 3000 });
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
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to reconcile transactions');
      }, { timeout: 3000 });
    });
  });

  describe('Liability Payment Prompt', () => {
    // Reconcile a liability account (Visa) to a -500 statement balance: a single
    // cleared -500 transaction against a reconciledBalance of 0 yields a $0
    // difference so the Finish button is enabled.
    async function finishLiabilityReconciliation() {
      mockGetReconciliationData.mockResolvedValue({
        transactions: [{
          id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
          payeeName: null, category: null, amount: -500, status: TransactionStatus.CLEARED,
        }],
        reconciledBalance: 0, clearedBalance: -500, difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Visa/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-2' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument(), { timeout: 3000 });
    }

    it('offers to update an existing scheduled payment for the account', async () => {
      mockScheduledGetAll.mockResolvedValue([
        { id: 'bill-1', name: 'Visa Payment', isTransfer: true, transferAccountId: 'acc-2', splits: [] },
      ]);
      await finishLiabilityReconciliation();
      expect(screen.getByText(/Visa Payment/)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Update Next Payment'));
      expect(mockRouterPush).toHaveBeenCalledWith('/bills?reconcileEditId=bill-1&reconcileAmount=500');
    });

    it('matches a scheduled payment linked via a split transfer', async () => {
      mockScheduledGetAll.mockResolvedValue([
        { id: 'bill-2', name: 'Paycheck Split', isTransfer: false, transferAccountId: null,
          splits: [{ transferAccountId: 'acc-2' }] },
      ]);
      await finishLiabilityReconciliation();
      fireEvent.click(screen.getByText('Update Next Payment'));
      expect(mockRouterPush).toHaveBeenCalledWith('/bills?reconcileEditId=bill-2&reconcileAmount=500');
    });

    it('offers to create a scheduled payment when none exists', async () => {
      mockScheduledGetAll.mockResolvedValue([
        { id: 'other', name: 'Unrelated', isTransfer: true, transferAccountId: 'acc-1', splits: [] },
      ]);
      await finishLiabilityReconciliation();
      expect(screen.getByText('Create Scheduled Payment')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Scheduled Payment'));
      expect(mockRouterPush).toHaveBeenCalledWith(
        '/bills?reconcileCreate=1&reconcileTransferAccountId=acc-2&reconcileAmount=500'
      );
    });

    it('does not show the payment prompt for a loan account', async () => {
      mockGetReconciliationData.mockResolvedValue({
        transactions: [{
          id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
          payeeName: null, category: null, amount: -8000, status: TransactionStatus.CLEARED,
        }],
        reconciledBalance: 0, clearedBalance: -8000, difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Car Loan/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-5' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '8000' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument(), { timeout: 3000 });
      expect(screen.queryByText('Update Next Payment')).not.toBeInTheDocument();
      expect(screen.queryByText('Create Scheduled Payment')).not.toBeInTheDocument();
      expect(mockScheduledGetAll).not.toHaveBeenCalled();
    });

    it('does not show the payment prompt for a non-liability account', async () => {
      mockGetReconciliationData.mockResolvedValue({
        transactions: [{
          id: 'tx-a', transactionDate: '2026-02-01', payee: { name: 'Test' },
          payeeName: null, category: null, amount: 500, status: TransactionStatus.CLEARED,
        }],
        reconciledBalance: 1000, clearedBalance: 1500, difference: 0,
      });
      render(<ReconcilePage />);
      await waitFor(() => expect(screen.getByText(/Checking/)).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
      fireEvent.change(screen.getByLabelText('Statement Ending Balance'), { target: { value: '1500' } });
      fireEvent.click(screen.getAllByText('Start Reconciliation').find(el => el.tagName === 'BUTTON')!);
      await waitFor(() => expect(screen.getByText('Finish Reconciliation')).toBeInTheDocument(), { timeout: 3000 });
      fireEvent.click(screen.getByText('Finish Reconciliation'));
      await waitFor(() => expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument(), { timeout: 3000 });
      expect(screen.queryByText('Update Next Payment')).not.toBeInTheDocument();
      expect(screen.queryByText('Create Scheduled Payment')).not.toBeInTheDocument();
      expect(mockScheduledGetAll).not.toHaveBeenCalled();
    });
  });
});
