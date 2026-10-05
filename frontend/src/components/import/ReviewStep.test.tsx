import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ReviewStep } from './ReviewStep';
import { Account } from '@/types/account';
import { CsvInvestmentSummary } from '@/lib/import';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'My Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, institutionId: null, openingBalance: 0, currentBalance: 1000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null, overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null, linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
    termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    statementDueDay: null, statementSettlementDay: null,
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
      accountName: '',
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
        fileType: 'qif' as const,
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
        fileType: 'qif' as const,
        parsedData: { ...defaultProps.parsedData, transactionCount: 10 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact',
      },
      {
        fileName: 'savings.qif',
        fileContent: '',
        fileType: 'qif' as const,
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

  // --- Investment summary section ---

  describe('investment summary', () => {
    const investmentSummary: CsvInvestmentSummary = {
      actionCounts: { buy: 3, dividend: 1 },
      cashFallbackValues: ['Journal'],
      uncostedShareRows: 2,
      rejectedRows: [{ reason: 'missingProceeds', count: 1 }],
    };

    function investmentFile(summary: CsvInvestmentSummary | undefined, fileName = 'trades.csv') {
      return {
        fileName,
        fileContent: '',
        fileType: 'csv' as const,
        parsedData: {
          ...defaultProps.parsedData,
          accountType: 'INVESTMENT',
          transactionCount: 4,
          investmentSummary: summary,
        },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact',
      };
    }

    it('renders per-action counts from the combined summary', () => {
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(investmentSummary)] as any[]} />
      );

      expect(screen.getByText('Investment Transactions')).toBeInTheDocument();
      expect(screen.getByText('Buy:')).toBeInTheDocument();
      expect(screen.getByText('Dividend:')).toBeInTheDocument();
      const buyItem = screen.getByText('Buy:').closest('li');
      expect(buyItem).toHaveTextContent('Buy: 3');
      const dividendItem = screen.getByText('Dividend:').closest('li');
      expect(dividendItem).toHaveTextContent('Dividend: 1');
      // Actions with a zero count are not listed
      expect(screen.queryByText('Sell:')).not.toBeInTheDocument();
    });

    it('renders the cash fallback notice listing the unmatched values', () => {
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(investmentSummary)] as any[]} />
      );

      expect(
        screen.getByText(
          'These action values were not recognized and will be imported as cash transactions: Journal'
        )
      ).toBeInTheDocument();
    });

    it('renders the uncosted share rows notice', () => {
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(investmentSummary)] as any[]} />
      );

      expect(
        screen.getByText('2 purchase rows have no price or amount and will be imported as added shares without cost.')
      ).toBeInTheDocument();
    });

    it('renders the rejected rows notice with per-reason counts and the go-back hint', () => {
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(investmentSummary)] as any[]} />
      );

      expect(screen.getByText('1 row cannot be imported:')).toBeInTheDocument();
      expect(screen.getByText(/Sell without price or proceeds/)).toBeInTheDocument();
      expect(
        screen.getByText('Go back to the column mapping step to adjust columns or action keywords.')
      ).toBeInTheDocument();
    });

    it('combines summaries across multiple import files', () => {
      const second = {
        actionCounts: { buy: 2, sell: 1 },
        cashFallbackValues: ['Sweep'],
        uncostedShareRows: 1,
        rejectedRows: [{ reason: 'missingProceeds', count: 2 }],
      };
      render(
        <ReviewStep
          {...defaultProps}
          isBulkImport={true}
          importFiles={[investmentFile(investmentSummary), investmentFile(second, 'more.csv')] as any[]}
        />
      );

      const buyItem = screen.getByText('Buy:').closest('li');
      expect(buyItem).toHaveTextContent('Buy: 5');
      const sellItem = screen.getByText('Sell:').closest('li');
      expect(sellItem).toHaveTextContent('Sell: 1');
      // Fallback values are merged (and sorted) across files
      expect(screen.getByText(/cash transactions: Journal, Sweep/)).toBeInTheDocument();
      expect(screen.getByText('3 rows cannot be imported:')).toBeInTheDocument();
      expect(screen.getByText(/Sell without price or proceeds/)).toBeInTheDocument();
    });

    it('omits amber and red notices when the summary has nothing to warn about', () => {
      const clean = {
        actionCounts: { buy: 3 },
        cashFallbackValues: [],
        uncostedShareRows: 0,
        rejectedRows: [],
      };
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(clean)] as any[]} />
      );

      expect(screen.getByText('Investment Transactions')).toBeInTheDocument();
      expect(screen.queryByText(/were not recognized/)).not.toBeInTheDocument();
      expect(screen.queryByText(/without cost/)).not.toBeInTheDocument();
      expect(screen.queryByText(/cannot be imported/)).not.toBeInTheDocument();
    });

    it('does not render the section for a parse without an investment summary', () => {
      render(
        <ReviewStep {...defaultProps} importFiles={[investmentFile(undefined)] as any[]} />
      );

      expect(screen.queryByText('Investment Transactions')).not.toBeInTheDocument();
    });
  });
});
