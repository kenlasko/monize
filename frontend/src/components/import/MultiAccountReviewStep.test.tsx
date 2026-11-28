import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MultiAccountReviewStep } from './MultiAccountReviewStep';
import type { ParsedQifMultiAccountResponse, DateFormat } from '@/lib/import';

const defaultMultiAccountData: ParsedQifMultiAccountResponse = {
  isMultiAccount: true,
  categoryDefs: [
    { name: 'Food', description: '', isIncome: false },
    { name: 'Salary', description: '', isIncome: true },
  ],
  tagDefs: [
    { name: 'Vacation', description: 'Travel' },
    { name: 'Business', description: 'Work' },
  ],
  accounts: [
    { accountName: 'Checking', accountType: 'Bank', transactionCount: 5, dateRange: { start: '2025-01-01', end: '2025-06-30' } },
    { accountName: 'Credit Card', accountType: 'CCard', transactionCount: 12, dateRange: { start: '2025-02-01', end: '2025-06-15' } },
  ],
  totalTransactionCount: 17,
  securities: [],
  detectedDateFormat: 'MM/DD/YYYY' as DateFormat,
  sampleDates: ['01/15/2025', '02/20/2025'],
};

describe('MultiAccountReviewStep', () => {
  const defaultProps = {
    multiAccountData: defaultMultiAccountData,
    currencyCode: 'CAD',
    onCurrencyChange: vi.fn(),
    currencyOptions: [
      { value: 'CAD', label: 'CAD - Canadian Dollar' },
      { value: 'USD', label: 'USD - US Dollar' },
    ],
    dateFormat: 'MM/DD/YYYY' as DateFormat,
    onDateFormatChange: vi.fn(),
    isLoading: false,
    onImport: vi.fn(),
    setStep: vi.fn(),
    hasSecuritiesToMap: false,
    accountTypeChoices: {} as Record<string, string>,
    onAccountTypeChoiceChange: vi.fn(),
    accountTypeOptions: [
      { value: 'CHEQUING', label: 'Chequing' },
      { value: 'CASH', label: 'Cash' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading and summary text', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.getByText('Multi-Account QIF Import')).toBeInTheDocument();
    expect(screen.getByText(/2 accounts/)).toBeInTheDocument();
    expect(screen.getByText(/2 categories/)).toBeInTheDocument();
    expect(screen.getByText(/17 transactions/)).toBeInTheDocument();
  });

  it('displays account list with types and transaction counts', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('(Bank)')).toBeInTheDocument();
    expect(screen.getByText('5 transactions')).toBeInTheDocument();
    expect(screen.getByText('Credit Card')).toBeInTheDocument();
    expect(screen.getByText('(CCard)')).toBeInTheDocument();
    expect(screen.getByText('12 transactions')).toBeInTheDocument();
  });

  it('displays category badges grouped by expense and income', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.getByText('Expense (1)')).toBeInTheDocument();
    expect(screen.getByText('Income (1)')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('displays sample dates', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.getByText(/01\/15\/2025, 02\/20\/2025/)).toBeInTheDocument();
  });

  it('calls onImport when Import All button is clicked', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    fireEvent.click(screen.getByText('Import All'));
    expect(defaultProps.onImport).toHaveBeenCalledTimes(1);
  });

  it('calls setStep with upload when Back button is clicked', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    fireEvent.click(screen.getByText('Back'));
    expect(defaultProps.setStep).toHaveBeenCalledWith('upload');
  });

  it('disables buttons when loading', () => {
    render(<MultiAccountReviewStep {...defaultProps} isLoading={true} />);
    expect(screen.getByText('Back')).toBeDisabled();
  });

  it('shows singular form for 1 account', () => {
    const singleAccountData = {
      ...defaultMultiAccountData,
      accounts: [defaultMultiAccountData.accounts[0]],
      categoryDefs: [defaultMultiAccountData.categoryDefs[0]],
      totalTransactionCount: 5,
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={singleAccountData} />);
    expect(screen.getByText(/1 account/)).toBeInTheDocument();
    expect(screen.getByText(/1 category/)).toBeInTheDocument();
  });

  it('displays tag badges when tagDefs present', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.getByText('Tags (2)')).toBeInTheDocument();
    expect(screen.getByText('Vacation')).toBeInTheDocument();
    expect(screen.getByText('Business')).toBeInTheDocument();
    expect(screen.getByText(/2 tags/)).toBeInTheDocument();
  });

  it('hides tags section when no tagDefs', () => {
    const noTagsData = { ...defaultMultiAccountData, tagDefs: [] };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={noTagsData} />);
    expect(screen.queryByText(/Tags \(/)).not.toBeInTheDocument();
  });

  it('shows securities notice and Next: Map Securities when hasSecuritiesToMap is true', () => {
    const dataWithSecurities = {
      ...defaultMultiAccountData,
      securities: [{ symbol: 'AAPL' }, { symbol: 'GOOG' }],
    } as any;
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={dataWithSecurities} hasSecuritiesToMap={true} />);
    expect(screen.getByText(/2 securities/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next: Map Securities'));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapSecurities');
  });

  it('hides sample dates section when sampleDates is empty', () => {
    const noSampleDates = { ...defaultMultiAccountData, sampleDates: [] };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={noSampleDates} />);
    expect(screen.queryByText(/Sample dates/)).not.toBeInTheDocument();
  });

  it('hides categories section when no categories', () => {
    const noCategories = { ...defaultMultiAccountData, categoryDefs: [] };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={noCategories} />);
    expect(screen.queryByText(/Categories \(/)).not.toBeInTheDocument();
  });

  it('hides expense section when no expense categories', () => {
    const incomeOnly = {
      ...defaultMultiAccountData,
      categoryDefs: [{ name: 'Salary', description: '', isIncome: true }],
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={incomeOnly} />);
    expect(screen.queryByText(/Expense \(/)).not.toBeInTheDocument();
    expect(screen.getByText(/Income \(/)).toBeInTheDocument();
  });

  it('hides income section when no income categories', () => {
    const expenseOnly = {
      ...defaultMultiAccountData,
      categoryDefs: [{ name: 'Food', description: '', isIncome: false }],
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={expenseOnly} />);
    expect(screen.queryByText(/Income \(/)).not.toBeInTheDocument();
    expect(screen.getByText(/Expense \(/)).toBeInTheDocument();
  });

  it('does not show date range when dateRange.start is falsy', () => {
    const dataWithoutDates = {
      ...defaultMultiAccountData,
      accounts: [
        { accountName: 'Checking', accountType: 'Bank', transactionCount: 5, dateRange: { start: '', end: '' } },
      ],
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={dataWithoutDates} />);
    expect(screen.queryByText(/\d+ to \d+/)).not.toBeInTheDocument();
  });

  it('shows singular security notice when hasSecuritiesToMap and 1 security', () => {
    const dataWithOneSecurity = {
      ...defaultMultiAccountData,
      securities: [{ symbol: 'AAPL' }],
    } as any;
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={dataWithOneSecurity} hasSecuritiesToMap={true} />);
    expect(screen.getByText(/1 security that need/)).toBeInTheDocument();
  });

  it('shows singular transaction count in account row', () => {
    const dataWithOneTransaction = {
      ...defaultMultiAccountData,
      accounts: [
        { accountName: 'Checking', accountType: 'Bank', transactionCount: 1, dateRange: { start: '', end: '' } },
      ],
      totalTransactionCount: 1,
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={dataWithOneTransaction} />);
    expect(screen.getByText('1 transaction')).toBeInTheDocument();
  });

  describe('accounts the file leaves untyped', () => {
    const untypedData: ParsedQifMultiAccountResponse = {
      ...defaultMultiAccountData,
      accounts: [
        ...defaultMultiAccountData.accounts,
        { accountName: 'Old Wallet', accountType: null, transactionCount: 0, dateRange: { start: '', end: '' } },
      ],
    };

    it('asks for a type and withholds the import until one is chosen', () => {
      render(<MultiAccountReviewStep {...defaultProps} multiAccountData={untypedData} />);
      const picker = screen.getByLabelText('Account type for Old Wallet');
      expect(picker).toHaveValue('');
      expect(screen.getByText(/does not say what type 1 account is/)).toBeInTheDocument();
      expect(screen.getByText('Import All').closest('button')).toBeDisabled();

      fireEvent.change(picker, { target: { value: 'CASH' } });
      expect(defaultProps.onAccountTypeChoiceChange).toHaveBeenCalledWith('Old Wallet', 'CASH');
    });

    it('offers the import once every untyped account has a type', () => {
      render(
        <MultiAccountReviewStep
          {...defaultProps}
          multiAccountData={untypedData}
          accountTypeChoices={{ 'Old Wallet': 'CASH' }}
        />,
      );
      expect(screen.getByLabelText('Account type for Old Wallet')).toHaveValue('CASH');
      expect(screen.queryByText(/does not say what type/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Import All'));
      expect(defaultProps.onImport).toHaveBeenCalledTimes(1);
    });

    it('withholds the step to securities too while a type is missing', () => {
      render(
        <MultiAccountReviewStep
          {...defaultProps}
          multiAccountData={untypedData}
          hasSecuritiesToMap={true}
        />,
      );
      expect(screen.getByText('Next: Map Securities').closest('button')).toBeDisabled();
    });
  });

  it('lists the QIF records whose amount cannot be read by line, without column-mapping advice', () => {
    const multiAccountData = {
      ...defaultMultiAccountData,
      unreadableAmounts: { count: 1, rows: [{ rowNumber: 9, rawAmount: '1,2,3.4.5' }] },
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={multiAccountData} />);
    expect(screen.getByText('1 row has an amount that cannot be read and will not be imported:')).toBeInTheDocument();
    expect(screen.getByText('Line 9: "1,2,3.4.5"')).toBeInTheDocument();
    expect(screen.getByText('Correct these amounts in the file and import it again.')).toBeInTheDocument();
    expect(screen.queryByText(/mapped correctly/)).not.toBeInTheDocument();
  });

  it('lists the QIF records whose date cannot be read by line, without column-mapping advice', () => {
    const multiAccountData = {
      ...defaultMultiAccountData,
      unreadableDates: {
        count: 2,
        rows: [
          { rowNumber: 9, rawDate: '13/45/2026' },
          { rowNumber: 12, rawDate: '' },
        ],
      },
    };
    render(<MultiAccountReviewStep {...defaultProps} multiAccountData={multiAccountData} />);
    expect(screen.getByText('2 records have dates that cannot be read and will not be imported:')).toBeInTheDocument();
    expect(screen.getByText('Line 9: "13/45/2026"')).toBeInTheDocument();
    expect(screen.getByText('Line 12: no date')).toBeInTheDocument();
    expect(screen.getByText('Correct these dates in the file and import it again.')).toBeInTheDocument();
    expect(screen.queryByText(/column mapping/)).not.toBeInTheDocument();
  });

  it('says unreadable dates are known only after the import while another date format is selected', () => {
    const multiAccountData = {
      ...defaultMultiAccountData,
      detectedDateFormat: 'MM/DD/YYYY' as const,
      unreadableDates: { count: 1, rows: [{ rowNumber: 9, rawDate: '13/45/2026' }] },
    };
    const { rerender } = render(
      <MultiAccountReviewStep {...defaultProps} dateFormat="MM/DD/YYYY" multiAccountData={multiAccountData} />,
    );
    expect(screen.getByText('Line 9: "13/45/2026"')).toBeInTheDocument();
    expect(screen.queryByText(/listed with the skipped rows afterwards/)).not.toBeInTheDocument();
    rerender(<MultiAccountReviewStep {...defaultProps} dateFormat="DD/MM/YYYY" multiAccountData={multiAccountData} />);
    expect(screen.queryByText('Line 9: "13/45/2026"')).not.toBeInTheDocument();
    expect(screen.getByText(/Dates that cannot be read as DD\/MM\/YYYY/)).toBeInTheDocument();
  });

  it('shows no unreadable-amount notice when every amount reads', () => {
    render(<MultiAccountReviewStep {...defaultProps} />);
    expect(screen.queryByText(/cannot be read/)).not.toBeInTheDocument();
  });
});
