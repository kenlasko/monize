import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
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
    name: 'Interest Expenses', description: null, icon: null, color: null, effectiveColor: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'cat-2', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Mortgage Interest', description: null, icon: null, color: null, effectiveColor: null,
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
    isEditing: false,
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

  it('renders the heading and all form fields', () => {
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

  it('renders term length years and months inputs', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Term Length')).toBeInTheDocument();
    // Should have Years and Months labels (2 each for term + amortization)
    const yearsLabels = screen.getAllByText('Years');
    const monthsLabels = screen.getAllByText('Months');
    expect(yearsLabels).toHaveLength(2);
    expect(monthsLabels).toHaveLength(2);
  });

  it('renders amortization period years and months inputs', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
  });

  it('populates term inputs from termMonths prop', () => {
    render(<MortgageFields {...defaultProps} termMonths={62} />);
    // 62 months = 5 years, 2 months
    const numberInputs = screen.getAllByRole('spinbutton');
    // Term years, term months, amort years, amort months
    expect(numberInputs[0]).toHaveValue(5);
    expect(numberInputs[1]).toHaveValue(2);
  });

  it('populates amortization inputs from amortizationMonths prop', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={303} />);
    // 303 months = 25 years, 3 months
    const numberInputs = screen.getAllByRole('spinbutton');
    expect(numberInputs[2]).toHaveValue(25);
    expect(numberInputs[3]).toHaveValue(3);
  });

  it('calls setValue when term years are changed', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[0], { target: { value: '5' } });
    expect(mockSetValue).toHaveBeenCalledWith('termMonths', 60, { shouldValidate: true, shouldDirty: true });
  });

  it('calls setValue when term months are changed', () => {
    render(<MortgageFields {...defaultProps} termMonths={60} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[1], { target: { value: '6' } });
    expect(mockSetValue).toHaveBeenCalledWith('termMonths', 66, { shouldValidate: true, shouldDirty: true });
  });

  it('calls setValue when amortization years are changed', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[2], { target: { value: '25' } });
    expect(mockSetValue).toHaveBeenCalledWith('amortizationMonths', 300, { shouldValidate: true, shouldDirty: true });
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

  it('hides payment fields when isEditing is true', () => {
    render(<MortgageFields {...defaultProps} isEditing={true} />);
    expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    expect(screen.getByText('Term Length')).toBeInTheDocument();
    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
    expect(screen.getByText('Canadian Mortgage')).toBeInTheDocument();
    // Payment fields should be hidden
    expect(screen.queryByText('Payment Frequency (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('First Payment Date (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment From Account (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('Interest Category')).not.toBeInTheDocument();
  });

  it('does not call preview API when isEditing is true', async () => {
    vi.useRealTimers();
    render(<MortgageFields {...defaultProps}
      isEditing={true}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    // Wait a bit for any debounced calls
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(accountsApi.previewMortgageAmortization).not.toHaveBeenCalled();
  });

  it('handles API error gracefully (no preview shown)', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewMortgageAmortization).mockRejectedValue(new Error('API Error'));

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(accountsApi.previewMortgageAmortization).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(screen.queryByText('Amortization Preview')).not.toBeInTheDocument();
  });

  it('calls setValue when amortization months are changed', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={300} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[3], { target: { value: '6' } });
    expect(mockSetValue).toHaveBeenCalledWith('amortizationMonths', 306, { shouldValidate: true, shouldDirty: true });
  });

  it('sets amortizationMonths to undefined when both years and months are 0', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={12} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    // Set years to 0
    fireEvent.change(numberInputs[2], { target: { value: '0' } });
    // Set months to 0
    fireEvent.change(numberInputs[3], { target: { value: '0' } });
    expect(mockSetValue).toHaveBeenCalledWith('amortizationMonths', undefined, { shouldValidate: true, shouldDirty: true });
  });

  it('debounces mortgage preview API call by 500ms', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1500, effectiveAnnualRate: 5.06,
      principalPayment: 1200, interestPayment: 300,
      totalPayments: 300, totalInterest: 150000, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    vi.advanceTimersByTime(400);
    expect(accountsApi.previewMortgageAmortization).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalledTimes(1);
  });

  it('passes isCanadian and isVariableRate to preview API', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1500, effectiveAnnualRate: 5.06,
      principalPayment: 1200, interestPayment: 300,
      totalPayments: 300, totalInterest: 150000, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
      isCanadianMortgage={true} isVariableRate={true}
    />);

    await vi.advanceTimersByTimeAsync(600);

    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalledWith(
      expect.objectContaining({
        isCanadian: true,
        isVariableRate: true,
      })
    );
  });

  it('shows N/A for totalPayments and totalInterest when 0', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 100, effectiveAnnualRate: 5.0,
      principalPayment: 0, interestPayment: 100,
      totalPayments: 0, totalInterest: 0, endDate: '',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    }, { timeout: 3000 });

    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(2);
  });

  it('shows all preview fields when preview data is complete', async () => {
    vi.useRealTimers();
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1500, effectiveAnnualRate: 5.06,
      principalPayment: 1200, interestPayment: 300,
      totalPayments: 300, totalInterest: 150000, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getByText('Payment Amount:')).toBeInTheDocument();
    expect(screen.getByText('Effective Rate:')).toBeInTheDocument();
    expect(screen.getByText('First Payment Principal:')).toBeInTheDocument();
    expect(screen.getByText('First Payment Interest:')).toBeInTheDocument();
    expect(screen.getByText('Total Payments:')).toBeInTheDocument();
    expect(screen.getByText('Total Interest:')).toBeInTheDocument();
    expect(screen.getByText('Est. Payoff Date:')).toBeInTheDocument();
    expect(screen.getByText('5.06%')).toBeInTheDocument();
  });

  it('does not allow term years above 99', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[0], { target: { value: '100' } });
    // Value should not change - setValue not called with invalid value
    expect(mockSetValue).not.toHaveBeenCalledWith('termMonths', 1200, expect.anything());
  });

  it('does not allow term months above 11', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[1], { target: { value: '12' } });
    expect(mockSetValue).not.toHaveBeenCalledWith('termMonths', 12, expect.anything());
  });

  it('shows term length help text', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Leave at 0 years and 0 months for no term.')).toBeInTheDocument();
  });
});
