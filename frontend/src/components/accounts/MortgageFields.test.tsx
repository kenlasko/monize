import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { MortgageFields } from './MortgageFields';
import { Account } from '@/types/account';
import { Category } from '@/types/category';

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, depth: 0 })),
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, options, value, onChange, placeholder }: any) => (
    <div data-testid={`combobox-${label}`}>
      {label && <label>{label}</label>}
      <select
        data-testid={`combobox-select-${label}`}
        value={value || ''}
        onChange={(e: any) => onChange?.(e.target.value)}
      >
        <option value="">{placeholder || 'Select...'}</option>
        {(options || []).map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    previewMortgageAmortization: vi.fn(),
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
  evaluateExpression: vi.fn().mockImplementation(() => undefined),
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
  {
    id: 'acc-2', userId: 'user-1', accountType: 'SAVINGS', accountSubType: null,
    linkedAccountId: null, name: 'Savings', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 10000, currentBalance: 10000,
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
  {
    id: 'cat-2', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Mortgage Interest', description: null, icon: null, color: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
];

describe('MortgageFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });
  const mockSetValue = vi.fn();
  const mockFormatCurrency = vi.fn((amount: number) => `$${amount.toFixed(2)}`);

  const defaultProps = {
    currencySymbol: '$',
    watchedCurrency: 'CAD',
    isCanadianMortgage: true,
    isVariableRate: false,
    interestRate: undefined as number | undefined,
    paymentFrequency: undefined as any,
    mortgagePaymentFrequency: undefined as any,
    paymentStartDate: undefined as string | undefined,
    openingBalance: undefined as number | undefined,
    originalPrincipal: undefined as number | undefined,
    termMonths: undefined as number | undefined,
    amortizationMonths: undefined as number | undefined,
    setValue: mockSetValue,
    register: mockRegister,
    errors: {},
    accounts: mockAccounts,
    categories: mockCategories,
    formatCurrency: mockFormatCurrency,
    selectedInterestCategoryId: '',
    handleInterestCategoryChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading and mortgage-specific fields', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency (required)')).toBeInTheDocument();
    expect(screen.getByText('First Payment Date (required)')).toBeInTheDocument();
    expect(screen.getByText('Interest Category')).toBeInTheDocument();
  });

  it('renders payment frequency options for mortgages', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Bi-Weekly')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Semi-Monthly (1st & 15th)')).toBeInTheDocument();
    expect(screen.getByText('Accelerated Bi-Weekly')).toBeInTheDocument();
    expect(screen.getByText('Accelerated Weekly')).toBeInTheDocument();
  });

  it('renders term length options', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Term Length')).toBeInTheDocument();
    expect(screen.getByText('5 years')).toBeInTheDocument();
    expect(screen.getByText('10 years')).toBeInTheDocument();
  });

  it('renders amortization period options', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
    expect(screen.getByText('25 years')).toBeInTheDocument();
    expect(screen.getByText('30 years')).toBeInTheDocument();
  });

  it('renders source account select with sorted accounts', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Payment From Account (required)')).toBeInTheDocument();
    expect(screen.getByText('Main Chequing (CAD)')).toBeInTheDocument();
    expect(screen.getByText('Savings (CAD)')).toBeInTheDocument();
  });

  it('renders interest category select with sorted categories', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Interest Category')).toBeInTheDocument();
    expect(screen.getByText('Interest Expenses')).toBeInTheDocument();
    expect(screen.getByText('Mortgage Interest')).toBeInTheDocument();
  });

  it('renders Canadian Mortgage and Variable Rate checkboxes', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Canadian Mortgage')).toBeInTheDocument();
    expect(screen.getByText('Variable Rate')).toBeInTheDocument();
    expect(screen.getByText(/semi-annual compounding/)).toBeInTheDocument();
    expect(screen.getByText(/Rate may change during the term/)).toBeInTheDocument();
  });

  it('does not show mortgage preview when required fields are missing', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.queryByText('Amortization Preview')).not.toBeInTheDocument();
  });

  it('renders with purple-themed border and background', () => {
    const { container } = render(<MortgageFields {...defaultProps} />);
    const wrapper = container.querySelector('.bg-purple-50');
    expect(wrapper).toBeInTheDocument();
  });

  it('shows amortization preview when API returns data', async () => {
    vi.useRealTimers();
    const mockPreview = {
      paymentAmount: 1500,
      effectiveAnnualRate: 5.06,
      principalPayment: 1200,
      interestPayment: 300,
      totalPayments: 300,
      totalInterest: 150000,
      endDate: '2049-01-15',
    };
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue(mockPreview);

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getByText('Payment Amount:')).toBeInTheDocument();
    expect(screen.getByText('Effective Rate:')).toBeInTheDocument();
  });

  it('shows "Calculating preview..." while loading', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewMortgageAmortization).mockImplementation(() => new Promise(() => {}));

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Calculating preview...')).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});
