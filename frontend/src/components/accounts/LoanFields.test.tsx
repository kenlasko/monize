import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoanFields } from './LoanFields';
import { Account } from '@/types/account';
import { Category } from '@/types/category';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    previewLoanAmortization: vi.fn(),
  },
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: (input: string) => { try { const r = new Function(`"use strict"; return (${input})`)(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : undefined; } catch { return undefined; } },
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
  }),
}));

import { accountsApi } from '@/lib/accounts';

const mockAccounts: Account[] = [
  {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'Main Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 5000, currentBalance: 5000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
];

const mockCategories: Category[] = [
  {
    id: 'cat-1', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Interest Expenses', description: null, icon: null, color: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
];

describe('LoanFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });
  const mockSetValue = vi.fn();
  const mockFormatCurrency = vi.fn((amount: number) => `$${amount.toFixed(2)}`);

  const defaultProps = {
    currencySymbol: '$',
    watchedCurrency: 'CAD',
    paymentAmount: undefined as number | undefined,
    interestRate: undefined as number | undefined,
    paymentFrequency: undefined as any,
    paymentStartDate: undefined as string | undefined,
    openingBalance: undefined as number | undefined,
    setValue: mockSetValue,
    register: mockRegister,
    errors: {},
    accounts: mockAccounts,
    categories: mockCategories,
    formatCurrency: mockFormatCurrency,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading and all form fields', () => {
    render(<LoanFields {...defaultProps} />);
    expect(screen.getByText('Loan Payment Details')).toBeInTheDocument();
    expect(screen.getByText('Payment Amount (required)')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency (required)')).toBeInTheDocument();
    expect(screen.getByText('First Payment Date (required)')).toBeInTheDocument();
    expect(screen.getByText('Payment From Account (required)')).toBeInTheDocument();
    expect(screen.getByText('Interest Category')).toBeInTheDocument();
  });

  it('renders payment frequency select options', () => {
    render(<LoanFields {...defaultProps} />);
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Every 2 Weeks')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Quarterly')).toBeInTheDocument();
    expect(screen.getByText('Yearly')).toBeInTheDocument();
  });

  it('renders accounts in the source account select', () => {
    render(<LoanFields {...defaultProps} />);
    const sourceAccountSelect = screen.getByLabelText('Payment From Account (required)');
    const options = sourceAccountSelect.querySelectorAll('option');
    expect(options[0].textContent).toBe('Select account...');
    expect(options[1].textContent).toBe('Main Chequing (CAD)');
  });

  it('renders categories in the interest category select', () => {
    render(<LoanFields {...defaultProps} />);
    const categorySelect = screen.getByLabelText('Interest Category');
    const options = categorySelect.querySelectorAll('option');
    expect(options[0].textContent).toBe('Select category...');
    expect(options[1].textContent).toBe('Interest Expenses');
  });

  it('does not show amortization preview when required fields are missing', () => {
    render(<LoanFields {...defaultProps} />);
    expect(screen.queryByText('Payment Preview (First Payment)')).not.toBeInTheDocument();
  });

  it('renders with blue-themed border and background', () => {
    const { container } = render(<LoanFields {...defaultProps} />);
    const wrapper = container.querySelector('.bg-blue-50');
    expect(wrapper).toBeInTheDocument();
  });

  it('shows amortization preview when API returns data', async () => {
    vi.useRealTimers();
    const mockPreview = {
      principalPayment: 450, interestPayment: 50,
      remainingBalance: 9550, totalPayments: 24, endDate: '2026-01-15',
    };
    vi.mocked(accountsApi.previewLoanAmortization).mockResolvedValue(mockPreview);

    render(<LoanFields {...defaultProps}
      openingBalance={10000} interestRate={5} paymentAmount={500}
      paymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Payment Preview (First Payment)')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getByText('Principal:')).toBeInTheDocument();
    expect(screen.getByText('Interest:')).toBeInTheDocument();
    expect(screen.getByText('Total Payments:')).toBeInTheDocument();
  });

  it('shows "Calculating preview..." while loading', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewLoanAmortization).mockImplementation(() => new Promise(() => {}));

    render(<LoanFields {...defaultProps}
      openingBalance={10000} interestRate={5} paymentAmount={500}
      paymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Calculating preview...')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('handles API error gracefully (no preview shown)', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewLoanAmortization).mockRejectedValue(new Error('API Error'));

    render(<LoanFields {...defaultProps}
      openingBalance={10000} interestRate={5} paymentAmount={500}
      paymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    // Wait for the API call to complete (500ms debounce + network)
    await waitFor(() => {
      expect(accountsApi.previewLoanAmortization).toHaveBeenCalled();
    }, { timeout: 3000 });

    // Preview should not be shown on error
    expect(screen.queryByText('Payment Preview (First Payment)')).not.toBeInTheDocument();
  });

  it('shows placeholder options in frequency and account selects', () => {
    render(<LoanFields {...defaultProps} />);
    expect(screen.getByText('Select frequency...')).toBeInTheDocument();
    expect(screen.getByText('Select account...')).toBeInTheDocument();
    expect(screen.getByText('Select category...')).toBeInTheDocument();
  });
});
