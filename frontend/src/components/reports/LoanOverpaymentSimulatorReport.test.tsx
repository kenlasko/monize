import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import { LoanOverpaymentSimulatorReport } from './LoanOverpaymentSimulatorReport';
import { Account } from '@/types/account';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetAll = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
  },
}));

const mockScenariosGetAll = vi.fn();
vi.mock('@/lib/loan-scenarios', () => ({
  loanScenariosApi: {
    getAll: (...args: unknown[]) => mockScenariosGetAll(...args),
  },
}));

const mockRateChangesGetAll = vi.fn();
vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    getAll: (...args: unknown[]) => mockRateChangesGetAll(...args),
  },
}));

const mockFetchAllTransactions = vi.fn();
vi.mock('@/lib/loan-history', () => ({
  fetchAllAccountTransactions: (...args: unknown[]) => mockFetchAllTransactions(...args),
}));

let loanViewProps: { account: Account; transactions: unknown[]; scenarios: unknown[] } | undefined;
vi.mock('@/components/accounts/loan-detail/LoanDetailView', () => ({
  LoanDetailView: (props: { account: Account; transactions: unknown[]; scenarios: unknown[] }) => {
    loanViewProps = props;
    return <div data-testid="loan-detail-view">{props.account.name}</div>;
  },
}));

let locViewAccount: Account | undefined;
vi.mock('@/components/accounts/loan-detail/LineOfCreditView', () => ({
  LineOfCreditView: (props: { account: Account }) => {
    locViewAccount = props.account;
    return <div data-testid="loc-view">{props.account.name}</div>;
  },
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

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<LoanOverpaymentSimulatorReport />);
  });
  await act(async () => {}); // flush the dependent per-account fetch
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  loanViewProps = undefined;
  locViewAccount = undefined;
  mockScenariosGetAll.mockResolvedValue([]);
  mockRateChangesGetAll.mockResolvedValue([]);
  mockFetchAllTransactions.mockResolvedValue([
    { id: 'tx-1', accountId: 'loan-1', transactionDate: '2026-01-15', amount: 450 },
  ]);
});

describe('LoanOverpaymentSimulatorReport', () => {
  it('lists only debt accounts and renders the detail view for the first', async () => {
    mockGetAll.mockResolvedValue([
      makeAccount(),
      makeAccount({ id: 'chq-1', accountType: 'CHEQUING', name: 'Checking' }),
      makeAccount({ id: 'mtg-1', accountType: 'MORTGAGE', name: 'Mortgage' }),
    ]);

    await renderReport();

    const select = screen.getByRole('combobox');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Car Loan', 'Mortgage']); // Checking excluded, sorted
    expect(screen.getByTestId('loan-detail-view')).toHaveTextContent('Car Loan');
    expect(loanViewProps?.transactions).toHaveLength(1);
    expect(mockGetAll).toHaveBeenCalledWith(true);
  });

  it('navigates to the register from the View Transactions button', async () => {
    mockGetAll.mockResolvedValue([makeAccount()]);

    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByText('View Transactions'));
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=loan-1');
  });

  it('loads transactions and scenarios for the selected loan', async () => {
    mockGetAll.mockResolvedValue([
      makeAccount(),
      makeAccount({ id: 'mtg-1', accountType: 'MORTGAGE', name: 'Mortgage' }),
    ]);

    await renderReport();

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mtg-1' } });
    });
    await act(async () => {}); // flush the dependent fetch

    expect(mockFetchAllTransactions).toHaveBeenCalledWith('mtg-1');
    expect(mockScenariosGetAll).toHaveBeenCalledWith('mtg-1');
    expect(loanViewProps?.account.id).toBe('mtg-1');
  });

  it('renders the revolving view for a line of credit without fetching transactions', async () => {
    mockGetAll.mockResolvedValue([
      makeAccount({ id: 'loc-1', accountType: 'LINE_OF_CREDIT', name: 'Credit Line' }),
    ]);

    await renderReport();

    expect(screen.getByTestId('loc-view')).toHaveTextContent('Credit Line');
    expect(locViewAccount?.id).toBe('loc-1');
    expect(mockFetchAllTransactions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('loan-detail-view')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no debt accounts', async () => {
    mockGetAll.mockResolvedValue([
      makeAccount({ id: 'chq-1', accountType: 'CHEQUING', name: 'Checking' }),
    ]);

    await renderReport();

    expect(
      screen.getByText('No loan, mortgage, or line of credit accounts found.'),
    ).toBeInTheDocument();
  });

  it('shows an error state when the accounts request fails', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));

    await renderReport();
    await act(async () => {});

    expect(screen.getByText('Try again')).toBeInTheDocument();
  });
});
