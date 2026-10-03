import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { MortgageFields } from './MortgageFields';
import { Account, MortgageType } from '@/types/account';
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
    detectMortgageType: vi.fn(),
  },
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  roundToDecimals: (v: number, d: number) => { const f = Math.pow(10, d); return Math.round(v * f) / f; },
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
    accountNumber: null, institution: null, institutionId: null, openingBalance: 5000, currentBalance: 5000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null, overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null, linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
    termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    statementDueDay: null, statementSettlementDay: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'acc-2', userId: 'user-1', accountType: 'SAVINGS', accountSubType: null,
    linkedAccountId: null, name: 'Savings', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, institutionId: null, openingBalance: 10000, currentBalance: 10000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null, overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null, linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
    termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    statementDueDay: null, statementSettlementDay: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
];

const mockCategories: Category[] = [
  {
    id: 'cat-1', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Interest Expenses', description: null, icon: null, color: null, effectiveColor: null, effectiveIcon: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'cat-2', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Mortgage Interest', description: null, icon: null, color: null, effectiveColor: null, effectiveIcon: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
];

/**
 * The four period fields -- [term years, term months, amortization years,
 * amortization months] -- in DOM order. They are `NumericInput`s, so they are
 * textboxes rather than the `spinbutton` a native number input exposes.
 */
function periodInputs() {
  const years = screen.getAllByLabelText('Years');
  const months = screen.getAllByLabelText('Months');
  return [years[0], months[0], years[1], months[1]];
}

describe('MortgageFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });
  const mockSetValue = vi.fn();
  const mockFormatCurrency = vi.fn((amount: number) => `$${amount.toFixed(2)}`);

  const defaultProps = {
    currencySymbol: '$',
    watchedCurrency: 'CAD',
    mortgageType: 'CANADIAN_FIXED' as MortgageType | undefined,
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
    interestBookingMode: 'AUTO' as const,
    handleInterestBookingModeChange: vi.fn(),
    selectedOverpaymentCategoryId: '',
    handleOverpaymentCategoryChange: vi.fn(),
    selectedOverpaymentPayeeId: '',
    handleOverpaymentPayeeChange: vi.fn(),
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
    expect(screen.getByText('Semi-Monthly (15th & month end)')).toBeInTheDocument();
    expect(screen.getByText('Accelerated Bi-Weekly')).toBeInTheDocument();
    expect(screen.getByText('Accelerated Weekly')).toBeInTheDocument();
  });

  it('renders term length years and months inputs', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText('Rate-Fixed Term')).toBeInTheDocument();
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
    const numberInputs = periodInputs();
    // Term years, term months, amort years, amort months
    expect(numberInputs[0]).toHaveValue('5');
    expect(numberInputs[1]).toHaveValue('2');
  });

  it('populates amortization inputs from amortizationMonths prop', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={303} />);
    // 303 months = 25 years, 3 months
    const numberInputs = periodInputs();
    expect(numberInputs[2]).toHaveValue('25');
    expect(numberInputs[3]).toHaveValue('3');
  });

  it('calls setValue when term years are changed', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = periodInputs();
    fireEvent.change(numberInputs[0], { target: { value: '5' } });
    expect(mockSetValue).toHaveBeenCalledWith('termMonths', 60, { shouldValidate: true, shouldDirty: true });
  });

  it('calls setValue when term months are changed', () => {
    render(<MortgageFields {...defaultProps} termMonths={60} />);
    const numberInputs = periodInputs();
    fireEvent.change(numberInputs[1], { target: { value: '6' } });
    expect(mockSetValue).toHaveBeenCalledWith('termMonths', 66, { shouldValidate: true, shouldDirty: true });
  });

  it('calls setValue when amortization years are changed', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = periodInputs();
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

  it('renders one Mortgage Type select in place of the two checkboxes', () => {
    render(<MortgageFields {...defaultProps} />);
    const select = screen.getByLabelText('Mortgage Type');
    expect(select.tagName).toBe('SELECT');
    expect(screen.queryByRole('checkbox', { name: /Canadian Mortgage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Variable Rate/ })).not.toBeInTheDocument();
  });

  it('offers all four types', () => {
    render(<MortgageFields {...defaultProps} />);
    const options = Array.from(
      (screen.getByLabelText('Mortgage Type') as HTMLSelectElement).options,
    ).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['ANNUITY', 'Annuity (Level Payment)'],
      ['CANADIAN_FIXED', 'Canadian Fixed Rate'],
      ['LINEAR', 'Linear (Constant Principal)'],
      ['INTEREST_ONLY', 'Interest Only'],
    ]);
  });

  it.each([
    ['ANNUITY', 'Your total payment is the same every month. Choose this for a variable-rate mortgage too.'],
    ['CANADIAN_FIXED', 'A Canadian fixed-rate contract; interest compounds twice a year.'],
    ['LINEAR', 'The principal part is the same every month and the total falls.'],
    ['INTEREST_ONLY', 'You pay only interest and the balance does not move.'],
  ] as const)('shows the help line for the selected %s type', (mortgageType, help) => {
    render(<MortgageFields {...defaultProps} mortgageType={mortgageType} />);
    expect(screen.getByText(help)).toBeInTheDocument();
  });

  it('asks what an extra repayment does for a LINEAR mortgage only', () => {
    const { rerender } = render(<MortgageFields {...defaultProps} mortgageType="LINEAR" />);
    const select = screen.getByLabelText('What an Extra Repayment Does') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['SHORTEN_TERM', 'Shortens the term (same principal each month)'],
      ['LOWER_INSTALLMENT', 'Lowers the installment (same end date)'],
    ]);
    expect(mockRegister).toHaveBeenCalledWith('prepaymentMode');

    for (const other of ['ANNUITY', 'CANADIAN_FIXED', 'INTEREST_ONLY'] as const) {
      rerender(<MortgageFields {...defaultProps} mortgageType={other} />);
      expect(screen.queryByLabelText('What an Extra Repayment Does')).not.toBeInTheDocument();
    }
  });

  it.each(['LINEAR', 'INTEREST_ONLY'] as const)(
    'offers no accelerated cadence for a %s mortgage',
    (mortgageType) => {
      render(<MortgageFields {...defaultProps} mortgageType={mortgageType} />);
      expect(screen.getByText('Bi-Weekly')).toBeInTheDocument();
      expect(screen.queryByText('Accelerated Bi-Weekly')).not.toBeInTheDocument();
      expect(screen.queryByText('Accelerated Weekly')).not.toBeInTheDocument();
    },
  );

  it('moves an accelerated cadence to its base when the type has no constant payment', () => {
    render(
      <MortgageFields
        {...defaultProps}
        mortgageType="ANNUITY"
        mortgagePaymentFrequency="ACCELERATED_BIWEEKLY"
      />,
    );
    fireEvent.change(screen.getByLabelText('Mortgage Type'), {
      target: { value: 'LINEAR' },
    });
    expect(mockSetValue).toHaveBeenCalledWith('mortgagePaymentFrequency', 'BIWEEKLY', {
      shouldDirty: true,
      shouldValidate: true,
    });
  });

  describe('type detection', () => {
    async function detectLinear() {
      vi.mocked(accountsApi.detectMortgageType).mockResolvedValue({
        type: 'LINEAR',
        confidence: 'high',
        reason: 'CONSTANT_PRINCIPAL',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Not sure? Enter a few installments' }));
      const principals = screen.getAllByLabelText('Principal');
      const interests = screen.getAllByLabelText('Interest');
      fireEvent.change(principals[0], { target: { value: '833.33' } });
      fireEvent.change(interests[0], { target: { value: '500.00' } });
      fireEvent.change(principals[1], { target: { value: '833.33' } });
      fireEvent.change(interests[1], { target: { value: '498.61' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Suggest a Type' }));
      });
    }

    it('offers the installment entry on create only', () => {
      const { unmount } = render(<MortgageFields {...defaultProps} />);
      expect(
        screen.getByRole('button', { name: 'Not sure? Enter a few installments' }),
      ).toBeInTheDocument();
      unmount();
      render(<MortgageFields {...defaultProps} isEditing />);
      expect(
        screen.queryByRole('button', { name: 'Not sure? Enter a few installments' }),
      ).not.toBeInTheDocument();
    });

    it('sends the quoted rate and cadence already on the form', async () => {
      render(
        <MortgageFields
          {...defaultProps}
          interestRate={2}
          mortgagePaymentFrequency="MONTHLY"
        />,
      );
      await detectLinear();
      expect(accountsApi.detectMortgageType).toHaveBeenCalledWith(
        expect.objectContaining({ interestRate: 2, paymentFrequency: 'MONTHLY' }),
      );
    });

    it('sets the Mortgage Type select when the suggestion is used', async () => {
      render(
        <MortgageFields {...defaultProps} mortgageType="ANNUITY" mortgagePaymentFrequency="MONTHLY" />,
      );
      await detectLinear();
      expect(mockSetValue).not.toHaveBeenCalledWith('mortgageType', expect.anything(), expect.anything());

      fireEvent.click(screen.getByRole('button', { name: 'Use This Type' }));
      expect(mockSetValue).toHaveBeenCalledWith('mortgageType', 'LINEAR', {
        shouldDirty: true,
        shouldValidate: true,
      });
      // A monthly cadence is one LINEAR keeps.
      expect(mockSetValue).not.toHaveBeenCalledWith(
        'mortgagePaymentFrequency',
        expect.anything(),
        expect.anything(),
      );
    });

    it('leaves the select untouched when the panel is closed', async () => {
      render(
        <MortgageFields {...defaultProps} mortgageType="ANNUITY" mortgagePaymentFrequency="MONTHLY" />,
      );
      await detectLinear();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(mockSetValue).not.toHaveBeenCalledWith('mortgageType', expect.anything(), expect.anything());
    });
  });

  it('leaves the cadence alone when the new type keeps a constant payment', () => {
    render(
      <MortgageFields
        {...defaultProps}
        mortgageType="LINEAR"
        mortgagePaymentFrequency="ACCELERATED_WEEKLY"
      />,
    );
    fireEvent.change(screen.getByLabelText('Mortgage Type'), {
      target: { value: 'CANADIAN_FIXED' },
    });
    expect(mockSetValue).not.toHaveBeenCalledWith(
      'mortgagePaymentFrequency',
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ['LINEAR', 'First Installment:'],
    ['INTEREST_ONLY', 'First Installment:'],
    ['ANNUITY', 'Payment Amount:'],
  ] as const)('captions a %s preview\'s payment as %s', async (mortgageType, caption) => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1333.3333,
      effectiveAnnualRate: 2.02,
      principalPayment: 833.3333,
      interestPayment: 500,
      totalPayments: 360,
      totalInterest: 90250,
      residualPayoffAmount: 834.7342,
      endDate: '2053-12-01',
    });
    render(<MortgageFields {...defaultProps}
      mortgageType={mortgageType}
      openingBalance={300000} interestRate={2} amortizationMonths={360}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-01-01"
    />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalledWith(
      expect.objectContaining({ mortgageType }),
    );
    expect(screen.getByText(caption)).toBeInTheDocument();
  });

  it('shows an interest-only preview\'s bullet as the final payment', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 500,
      effectiveAnnualRate: 2.02,
      principalPayment: 0,
      interestPayment: 500,
      totalPayments: 360,
      totalInterest: 180000,
      residualPayoffAmount: 300500,
      endDate: '2053-12-01',
    });
    render(<MortgageFields {...defaultProps}
      mortgageType="INTEREST_ONLY"
      openingBalance={300000} interestRate={2} amortizationMonths={360}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-01-01"
    />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByText('Final Payment:')).toBeInTheDocument();
    expect(screen.getByText('$300500.00')).toBeInTheDocument();
  });

  it('says nothing about monthly compounding', () => {
    const { container } = render(<MortgageFields {...defaultProps} mortgageType="ANNUITY" />);
    expect(container.textContent).not.toMatch(/monthly compounding/i);
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

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.getByText('Payment Amount:')).toBeInTheDocument();
    expect(screen.getByText('Effective Rate:')).toBeInTheDocument();
  });

  it('shows "Calculating preview..." while loading', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockImplementation(() => new Promise(() => {}));

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(screen.getByText('Calculating preview...')).toBeInTheDocument();
  });

  it('hides payment fields when isEditing is true', () => {
    render(<MortgageFields {...defaultProps} isEditing={true} />);
    expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    expect(screen.getByText('Rate-Fixed Term')).toBeInTheDocument();
    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
    expect(screen.getByLabelText('Mortgage Type')).toBeInTheDocument();
    // Payment-setup fields (create-only) should be hidden
    expect(screen.queryByText('Payment Frequency (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('First Payment Date (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment From Account (required)')).not.toBeInTheDocument();
    // Recognition settings (interest category + overpayment) stay available on edit
    expect(screen.getByText('Interest Category')).toBeInTheDocument();
    expect(screen.getByText('Overpayment recognition')).toBeInTheDocument();
  });

  it.each(['ANNUITY', 'CANADIAN_FIXED'] as const)(
    'shows the Loan Details link for a %s mortgage when editing and onViewLoanDetails is provided',
    (mortgageType) => {
      const onViewLoanDetails = vi.fn();
      render(
        <MortgageFields
          {...defaultProps}
          mortgageType={mortgageType}
          isEditing={true}
          onViewLoanDetails={onViewLoanDetails}
        />,
      );
      expect(screen.getByText(/Record rate changes in/)).toBeInTheDocument();
      const link = screen.getByRole('button', { name: 'Loan Details' });
      fireEvent.click(link);
      expect(onViewLoanDetails).toHaveBeenCalledTimes(1);
    },
  );

  it('hides the Loan Details link when not editing', () => {
    render(<MortgageFields {...defaultProps} isEditing={false} onViewLoanDetails={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Loan Details' })).not.toBeInTheDocument();
  });

  it('hides the Loan Details link when onViewLoanDetails is absent', () => {
    render(<MortgageFields {...defaultProps} isEditing={true} />);
    expect(screen.queryByRole('button', { name: 'Loan Details' })).not.toBeInTheDocument();
  });

  it('does not call preview API when isEditing is true', async () => {
    render(<MortgageFields {...defaultProps}
      isEditing={true}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(accountsApi.previewMortgageAmortization).not.toHaveBeenCalled();
  });

  it('handles API error gracefully (no preview shown)', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockRejectedValue(new Error('API Error'));

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalled();
    expect(screen.queryByText('Amortization Preview')).not.toBeInTheDocument();
  });

  it('calls setValue when amortization months are changed', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={300} />);
    const numberInputs = periodInputs();
    fireEvent.change(numberInputs[3], { target: { value: '6' } });
    expect(mockSetValue).toHaveBeenCalledWith('amortizationMonths', 306, { shouldValidate: true, shouldDirty: true });
  });

  it('sets amortizationMonths to undefined when both years and months are 0', () => {
    render(<MortgageFields {...defaultProps} amortizationMonths={12} />);
    const numberInputs = periodInputs();
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

    await act(async () => { vi.advanceTimersByTime(400); });
    expect(accountsApi.previewMortgageAmortization).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalledTimes(1);

    // Switch to real timers so waitFor can poll properly
    vi.useRealTimers();

    // Wait for state updates from the resolved API call
    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });
  });

  it.each(['CANADIAN_FIXED', 'ANNUITY'] as const)('sends the %s type to the preview API', async (mortgageType) => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1500, effectiveAnnualRate: 5.06,
      principalPayment: 1200, interestPayment: 300,
      totalPayments: 300, totalInterest: 150000, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
      mortgageType={mortgageType}
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(accountsApi.previewMortgageAmortization).toHaveBeenCalledWith(
      expect.objectContaining({ mortgageType })
    );

    // Switch to real timers so waitFor can poll properly
    vi.useRealTimers();

    // Wait for state updates from the resolved API call
    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });
  });

  it('shows N/A for totalPayments and totalInterest when 0', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 100, effectiveAnnualRate: 5.0,
      principalPayment: 0, interestPayment: 100,
      totalPayments: 0, totalInterest: 0, endDate: '',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(2);
  });

  it('shows all preview fields when preview data is complete', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1500, effectiveAnnualRate: 5.06,
      principalPayment: 1200, interestPayment: 300,
      totalPayments: 300, totalInterest: 150000, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.getByText('Payment Amount:')).toBeInTheDocument();
    expect(screen.getByText('Effective Rate:')).toBeInTheDocument();
    expect(screen.getByText('First Payment Principal:')).toBeInTheDocument();
    expect(screen.getByText('First Payment Interest:')).toBeInTheDocument();
    expect(screen.getByText('Total Payments:')).toBeInTheDocument();
    expect(screen.getByText('Total Interest:')).toBeInTheDocument();
    expect(screen.getByText('Est. Payoff Date:')).toBeInTheDocument();
    expect(screen.getByText('5.06%')).toBeInTheDocument();
    // The residual payoff row is absent when the API does not send it (an older
    // backend during a rolling deploy) -- read defensively, never as a zero.
    expect(screen.queryByText('Final Payment:')).not.toBeInTheDocument();
  });

  it('shows the final payment only when it is below the installment', async () => {
    // An accelerated schedule's analytic payoff count is fractional, so the last
    // payment is a small residual rather than another full installment. That is
    // the case the row exists for.
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 876.89, effectiveAnnualRate: 5.12,
      principalPayment: 300, interestPayment: 576.89,
      totalPayments: 559, residualPayoffAmount: 307.76,
      totalInterest: 189609.59, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={300000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="ACCELERATED_BIWEEKLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.getByText('Final Payment:')).toBeInTheDocument();
    expect(screen.getByText('$307.76')).toBeInTheDocument();
  });

  it('hides the final payment row for a standard schedule', async () => {
    // A standard schedule's residual is within a rounding step of the
    // installment, so repeating it would be noise.
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1753.77, effectiveAnnualRate: 5.12,
      principalPayment: 503.77, interestPayment: 1250,
      totalPayments: 300, residualPayoffAmount: 1753.78,
      totalInterest: 226131.04, endDate: '2049-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={300000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.queryByText('Final Payment:')).not.toBeInTheDocument();
  });

  it('hides the final payment row when the payment never amortizes', async () => {
    // -1 means "could not be worked out", not "the last payment is -1".
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 100, effectiveAnnualRate: 5.12,
      principalPayment: 0, interestPayment: 100,
      totalPayments: -1, residualPayoffAmount: -1,
      totalInterest: -1, endDate: '2124-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={300000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.queryByText('Final Payment:')).not.toBeInTheDocument();
    expect(screen.queryByText('$-1.00')).not.toBeInTheDocument();
  });

  it('shows a known zero total interest rather than N/A', async () => {
    // A 0% mortgage costs no interest, and the residual math makes that exactly
    // 0. `totalInterest > 0` collapsed the known zero into the -1 "could not be
    // worked out" sentinel and printed N/A.
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 1000, effectiveAnnualRate: 0,
      principalPayment: 1000, interestPayment: 0,
      totalPayments: 120, residualPayoffAmount: 1000,
      totalInterest: 0, endDate: '2036-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={120000} interestRate={0} amortizationMonths={120}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    // Scoped to the Total Interest row: "$0.00" also appears as the first
    // payment's interest on a 0% mortgage, so a bare text match is ambiguous.
    const totalInterestRow = screen.getByText('Total Interest:').parentElement;
    expect(totalInterestRow).toHaveTextContent('$0.00');
    expect(totalInterestRow).not.toHaveTextContent('N/A');
  });

  it('shows N/A for a total interest that could not be worked out', async () => {
    vi.mocked(accountsApi.previewMortgageAmortization).mockResolvedValue({
      paymentAmount: 100, effectiveAnnualRate: 5.12,
      principalPayment: 0, interestPayment: 100,
      totalPayments: -1, residualPayoffAmount: -1,
      totalInterest: -1, endDate: '2124-01-15',
    });

    render(<MortgageFields {...defaultProps}
      openingBalance={300000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText('Amortization Preview')).toBeInTheDocument();
    });

    expect(screen.queryByText('$-1.00')).not.toBeInTheDocument();
  });

  it('does not allow term years above 99', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = periodInputs();
    fireEvent.change(numberInputs[0], { target: { value: '100' } });
    // Value should not change - setValue not called with invalid value
    expect(mockSetValue).not.toHaveBeenCalledWith('termMonths', 1200, expect.anything());
  });

  it('does not allow term months above 11', () => {
    render(<MortgageFields {...defaultProps} />);
    const numberInputs = periodInputs();
    fireEvent.change(numberInputs[1], { target: { value: '12' } });
    expect(mockSetValue).not.toHaveBeenCalledWith('termMonths', 12, expect.anything());
  });

  it('shows term length help text', () => {
    render(<MortgageFields {...defaultProps} />);
    expect(screen.getByText(/Leave at 0 years and 0 months for no term\./)).toBeInTheDocument();
  });

  it('does not ask for a preview while the type is unknown', async () => {
    render(<MortgageFields {...defaultProps}
      mortgageType={undefined}
      openingBalance={400000} interestRate={5} amortizationMonths={300}
      mortgagePaymentFrequency="MONTHLY" paymentStartDate="2024-02-01"
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(accountsApi.previewMortgageAmortization).not.toHaveBeenCalled();
  });

  it.each(['ANNUITY', 'CANADIAN_FIXED', 'LINEAR', 'INTEREST_ONLY'] as const)(
    'shows the Term Length field for a %s mortgage',
    (mortgageType) => {
      render(<MortgageFields {...defaultProps} mortgageType={mortgageType} termMonths={60} />);
      expect(screen.getByText('Rate-Fixed Term')).toBeInTheDocument();
      expect(periodInputs()[0]).toHaveValue('5');
      expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
    },
  );

  it('keeps the term of a non-Canadian mortgage rather than clearing it', () => {
    // The term was a Canada-only field that an effect zeroed for every other
    // mortgage; it is now the rate-fixed period of every type.
    render(<MortgageFields {...defaultProps} mortgageType="ANNUITY" termMonths={60} />);
    expect(mockSetValue).not.toHaveBeenCalledWith('termMonths', 0, expect.anything());
  });

  it('lets the term of a non-Canadian mortgage be edited', () => {
    render(<MortgageFields {...defaultProps} mortgageType="ANNUITY" termMonths={60} />);
    fireEvent.change(periodInputs()[0], { target: { value: '3' } });
    expect(mockSetValue).toHaveBeenCalledWith('termMonths', 36, { shouldValidate: true, shouldDirty: true });
  });
});
