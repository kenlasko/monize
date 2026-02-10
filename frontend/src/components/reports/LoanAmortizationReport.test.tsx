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
});
