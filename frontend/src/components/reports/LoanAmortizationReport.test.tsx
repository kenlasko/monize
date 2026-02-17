import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoanAmortizationReport } from './LoanAmortizationReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

const mockGetAllAccounts = vi.fn();
const mockGetAllTransactions = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
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

describe('LoanAmortizationReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    render(<LoanAmortizationReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no loan accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText(/No loan or mortgage accounts found/)).toBeInTheDocument();
    });
  });

  it('renders account selector and summary with data', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-01', amount: 350, linkedTransaction: null },
      ],
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('renders payment history table header', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Student Loan',
        accountType: 'LOAN',
        currentBalance: -5000,
        openingBalance: -15000,
        interestRate: 3.5,
        paymentAmount: 200,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-03-01', amount: 180, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-04-01', amount: 180, linkedTransaction: null },
      ],
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    });
  });

  it('selects first account by default when multiple accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: true, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    // Both accounts should appear as options
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
  });

  it('filters out non-loan account types', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'chequing-1', name: 'Chequing', accountType: 'CHEQUING',
        currentBalance: 5000, openingBalance: 5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -15000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.queryByText('Chequing')).not.toBeInTheDocument();
  });

  it('shows "No payments found" when account has no transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'New Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText(/No payments found for this loan/)).toBeInTheDocument();
    });
  });

  it('displays summary cards with correct values', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -8000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 350, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 350, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
    expect(screen.getByText('Original Amount')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('shows "Not set" when interest rate is null', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'Line of Credit', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      // Multiple "Not set" texts (interestRate, paymentFrequency, paymentAmount are all null)
      const notSetElements = screen.getAllByText('Not set');
      expect(notSetElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays account details section with correct type labels', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'My Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 4.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Type')).toBeInTheDocument();
    });
    expect(screen.getByText('Loan')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows "Closed" status for closed accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Old Loan', accountType: 'LOAN',
        currentBalance: 0, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: true,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });
  });

  it('renders payment table with correct columns', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('#')).toBeInTheDocument();
    });
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByText('Interest')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
  });

  it('renders payment table with interest from linked transaction splits', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1', transactionDate: '2024-01-15', amount: 450,
          linkedTransaction: {
            id: 'parent-1',
            splits: [
              { amount: -450, transferAccountId: 'loan-1' },
              { amount: -50, transferAccountId: 'interest-expense' },
            ],
          },
        },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      // Check payment history header shows correct count after transactions load
      expect(screen.getByText(/1 payments made/)).toBeInTheDocument();
    });
  });

  it('shows "Payment History & Projection" header when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Payment History & Projection')).toBeInTheDocument();
    });
  });

  it('shows "Payment History" header when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Payment History')).toBeInTheDocument();
    });
  });

  it('shows "Projected Future Payments" separator row', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    });
  });

  it('shows Est. Payoff card when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('shows "Est. Total Interest" label when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Total Interest')).toBeInTheDocument();
    });
  });

  it('shows "Total Interest Paid" label when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Interest Paid')).toBeInTheDocument();
    });
  });

  it('displays Mortgage account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: true, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 1000, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Mortgage')).toBeInTheDocument();
    });
  });

  it('displays Line of Credit account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: 8.0,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Line of Credit')).toBeInTheDocument();
    });
  });

  it('paginates through transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    // First page has more, second page doesn't
    mockGetAllTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-02-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: false },
      });
    render(<LoanAmortizationReport />);
    await waitFor(() => {
      expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/2 payments made/)).toBeInTheDocument();
    });
  });
});
