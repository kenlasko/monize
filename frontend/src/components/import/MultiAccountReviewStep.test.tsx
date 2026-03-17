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
});
