import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import AccountDetailPage from './page';
import { Account } from '@/types/account';

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/accounts/loan-1',
  useParams: () => ({ id: 'loan-1' }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: { id: 'user-1', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'user-1', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

const mockGetById = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getById: (...args: unknown[]) => mockGetById(...args),
  },
}));

const mockGetAllTransactions = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => mockGetAllTransactions(...args),
  },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -8000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AccountDetailPage />);
  });
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllTransactions.mockResolvedValue({
    data: [
      {
        id: 'tx-1',
        accountId: 'loan-1',
        transactionDate: '2026-01-15',
        amount: 450,
        linkedTransaction: null,
      },
    ],
    pagination: { hasMore: false },
  });
});

describe('AccountDetailPage', () => {
  it('renders the loan detail view for a loan account', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText(/Loan - CAD/)).toBeInTheDocument();
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Installment Schedule')).toBeInTheDocument();
    expect(mockGetById).toHaveBeenCalledWith('loan-1');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('projects future payments from the account terms', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
  });

  it('redirects non-loan accounts to their transaction register', async () => {
    mockGetById.mockResolvedValue(makeAccount({ accountType: 'CHEQUING' }));

    await renderPage();

    expect(mockReplace).toHaveBeenCalledWith('/transactions?accountId=loan-1');
  });

  it('shows an error state with a back button when loading fails', async () => {
    mockGetById.mockRejectedValue(new Error('boom'));

    await renderPage();
    await act(async () => {}); // flush pending rejection handlers

    expect(screen.getByText('Failed to load account details')).toBeInTheDocument();
    const backButton = screen.getByText('Back to Accounts');
    await act(async () => {
      backButton.click();
    });
    expect(mockPush).toHaveBeenCalledWith('/accounts');
  });

  it('navigates to the transaction register from the header action', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    const viewTransactions = screen.getByText('View Transactions');
    await act(async () => {
      viewTransactions.click();
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=loan-1');
  });
});
