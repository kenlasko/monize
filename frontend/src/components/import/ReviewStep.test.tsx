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

  it('shows Summary heading for single file import', () => {
    render(<ReviewStep {...defaultProps} />);
    expect(screen.getByText('Summary')).toBeInTheDocument();
  });

  // --- Category mappings section ---

  it('shows category mapping summary when present', () => {
    const categoryMappings = [
      { originalName: 'Food', categoryId: 'c1', createNew: undefined, isLoanCategory: false },
      { originalName: 'Gas', categoryId: undefined, createNew: 'Gas', isLoanCategory: false },
      { originalName: 'Mortgage', categoryId: undefined, createNew: undefined, isLoanCategory: true, createNewLoan: 'My Mortgage' },
    ] as any[];
    render(<ReviewStep {...defaultProps} categoryMappings={categoryMappings} />);
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
  });

  it('shows new categories to create count', () => {
    const categoryMappings = [
      { originalName: 'Food', categoryId: undefined, createNew: 'Food', isLoanCategory: false },
      { originalName: 'Gas', categoryId: undefined, createNew: 'Gas', isLoanCategory: false },
    ] as any[];
    render(<ReviewStep {...defaultProps} categoryMappings={categoryMappings} />);
    expect(screen.getByText(/New categories to create:/)).toBeInTheDocument();
  });

  it('shows loan categories count when present', () => {
    const categoryMappings = [
      { originalName: 'Mortgage', categoryId: undefined, createNew: undefined, isLoanCategory: true, loanAccountId: 'loan1' },
    ] as any[];
    render(<ReviewStep {...defaultProps} categoryMappings={categoryMappings} />);
    expect(screen.getByText(/Mapped to loan accounts:/)).toBeInTheDocument();
  });

  it('shows new loan accounts count when present', () => {
    const categoryMappings = [
      { originalName: 'Mortgage', categoryId: undefined, createNew: undefined, isLoanCategory: true, createNewLoan: 'My Loan' },
    ] as any[];
    render(<ReviewStep {...defaultProps} categoryMappings={categoryMappings} />);
    expect(screen.getByText(/New loan accounts to create:/)).toBeInTheDocument();
  });

  // --- Account mappings section ---

  it('shows account mapping summary when present', () => {
    const accountMappings = [
      { originalName: 'Savings', accountId: 'a1', createNew: '' },
      { originalName: 'New Acct', accountId: '', createNew: 'New Account' },
    ] as any[];
    render(<ReviewStep {...defaultProps} accountMappings={accountMappings} />);
    expect(screen.getByText('Transfer Accounts')).toBeInTheDocument();
    expect(screen.getByText(/New to create:/)).toBeInTheDocument();
  });

  // --- Security mappings section ---

  it('shows security mapping summary when present', () => {
    const securityMappings = [
      { originalName: 'AAPL', securityId: 's1', createNew: '' },
      { originalName: 'MSFT', securityId: '', createNew: 'MSFT' },
    ] as any[];
    render(<ReviewStep {...defaultProps} securityMappings={securityMappings} />);
    expect(screen.getByText('Securities')).toBeInTheDocument();
  });

  // --- Back button navigation ---

  it('navigates back to selectAccount when no mappings', () => {
    render(<ReviewStep {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('selectAccount');
  });

  it('navigates back to mapAccounts when shouldShowMapAccounts', () => {
    render(<ReviewStep {...defaultProps} shouldShowMapAccounts={true} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapAccounts');
  });

  it('navigates back to mapSecurities when security mappings exist', () => {
    const securityMappings = [{ originalName: 'AAPL', securityId: 's1', createNew: '' }] as any[];
    render(<ReviewStep {...defaultProps} securityMappings={securityMappings} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapSecurities');
  });

  it('navigates back to mapCategories when category mappings exist', () => {
    const categoryMappings = [{ originalName: 'Food', categoryId: 'c1', isLoanCategory: false }] as any[];
    render(<ReviewStep {...defaultProps} categoryMappings={categoryMappings} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapCategories');
  });

  // --- Bulk import mode ---

  it('shows Files to Import heading for bulk import', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 10 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact',
      },
    ] as any[];
    render(
      <ReviewStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText('Files to Import')).toBeInTheDocument();
  });

  it('shows per-file details in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'checking.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 10 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact',
      },
      {
        fileName: 'savings.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact',
      },
    ] as any[];
    render(
      <ReviewStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText(/checking\.qif/)).toBeInTheDocument();
    expect(screen.getByText(/savings\.qif/)).toBeInTheDocument();
    expect(screen.getByText(/15 transactions/)).toBeInTheDocument();
  });
});
