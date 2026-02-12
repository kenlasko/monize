import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ReviewStep } from './ReviewStep';
import { Account } from '@/types/account';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'My Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 0, currentBalance: 1000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ReviewStep', () => {
  const account = createAccount();
  const defaultProps = {
    importFiles: [],
    isBulkImport: false,
    fileName: 'test.qif',
    parsedData: {
      transactions: [{ date: '2024-01-01', amount: -50, payee: 'Test', memo: '', category: '', number: '' }],
      investmentTransactions: [],
      qifType: 'Bank' as const,
      accountType: 'Bank',
      accountName: null,
      transactionCount: 5,
      dateRange: { start: '2024-01-01', end: '2024-01-31' },
      categories: [],
      securities: [],
      transferAccounts: [],
      detectedDateFormat: 'YYYY-MM-DD' as const,
      sampleDates: [],
    },
    selectedAccountId: 'acc-1',
    accounts: [account],
    categoryMappings: [],
    accountMappings: [],
    securityMappings: [],
    shouldShowMapAccounts: false,
    isLoading: false,
    handleImport: vi.fn(),
    setStep: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the review heading', () => {
    render(<ReviewStep {...defaultProps} />);

    expect(screen.getByText('Review Import')).toBeInTheDocument();
  });

  it('shows file name and transaction count', () => {
    render(<ReviewStep {...defaultProps} />);

    expect(screen.getByText(/test\.qif/)).toBeInTheDocument();
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  it('shows the target account name', () => {
    render(<ReviewStep {...defaultProps} />);

    expect(screen.getByText('My Chequing')).toBeInTheDocument();
  });

  it('calls handleImport when Import button is clicked', () => {
    render(<ReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Import/i }));
    expect(defaultProps.handleImport).toHaveBeenCalledTimes(1);
  });

  it('disables Import button when isLoading', () => {
    render(<ReviewStep {...defaultProps} isLoading={true} />);

    expect(screen.getByRole('button', { name: /Import Transactions/i })).toBeDisabled();
  });
});
