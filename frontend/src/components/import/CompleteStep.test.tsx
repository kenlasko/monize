import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CompleteStep } from './CompleteStep';
import { Account } from '@/types/account';
import { ImportFileData } from '@/app/import/import-utils';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

function createImportFile(
  fileName: string,
  selectedAccountId: string,
  accountType = 'CHEQUING',
): ImportFileData {
  return {
    fileName,
    fileContent: '',
    fileType: 'qif',
    parsedData: {
      accountType,
      accountName: '',
      transactionCount: 1,
      categories: [],
      transferAccounts: [],
      securities: [],
      dateRange: { start: '2024-01-01', end: '2024-01-31' },
      detectedDateFormat: 'YYYY-MM-DD',
      sampleDates: [],
    },
    selectedAccountId,
    matchConfidence: 'exact',
  };
}

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    detectLoanPayments: vi.fn().mockResolvedValue(null),
    setupLoanPayments: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/components/accounts/LoanPaymentSetupDialog', () => ({
  LoanPaymentSetupDialog: ({ isOpen, onClose, onSetupComplete, loanAccount }: any) =>
    isOpen ? (
      <div
        data-testid="loan-payment-setup-dialog"
        data-mortgage-type={String(loanAccount?.mortgageType)}
      >
        <button data-testid="close-dialog" onClick={onClose}>Close</button>
        <button data-testid="setup-complete" onClick={onSetupComplete}>Complete Setup</button>
      </div>
    ) : null,
}));

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

describe('CompleteStep', () => {
  const account = createAccount();
  const defaultProps = {
    importFiles: [],
    isBulkImport: false,
    fileName: 'test.qif',
    selectedAccountId: 'acc-1',
    accounts: [account],
    importResult: {
      imported: 10,
      skipped: 2,
      errors: 0,
      errorMessages: [],
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
    },
    bulkImportResult: null,
    onImportMore: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the complete heading', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText('Import Complete')).toBeInTheDocument();
  });

  it('shows import result counts', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText(/10/)).toBeInTheDocument();
  });

  it('shows Import More Files button', () => {
    render(<CompleteStep {...defaultProps} />);
    const importMoreButton = screen.getByRole('button', { name: /Import More/i });
    expect(importMoreButton).toBeInTheDocument();
  });

  it('calls onImportMore when button is clicked', () => {
    render(<CompleteStep {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Import More/i }));
    expect(defaultProps.onImportMore).toHaveBeenCalledTimes(1);
  });

  it('shows View Transactions link', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText(/View Transactions/i)).toBeInTheDocument();
  });

  it('shows single file import details', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText(/test\.qif/)).toBeInTheDocument();
    expect(screen.getByText('My Chequing')).toBeInTheDocument();
    expect(screen.getByText(/10 transactions/)).toBeInTheDocument();
    expect(screen.getByText(/2 duplicate transfers/)).toBeInTheDocument();
  });

  it('shows error messages when present in single import', () => {
    const result = {
      ...defaultProps.importResult!,
      errors: 2,
      errorMessages: ['Row 5: Invalid date', 'Row 12: Missing payee'],
    };
    render(<CompleteStep {...defaultProps} importResult={result} />);
    expect(screen.getAllByText('Errors:').length).toBeGreaterThan(0);
    expect(screen.getByText('Row 5: Invalid date')).toBeInTheDocument();
    expect(screen.getByText('Row 12: Missing payee')).toBeInTheDocument();
  });

  it('shows "View Investments" for investment files', () => {
    const importFiles = [
      {
        fileName: 'portfolio.qif',
        fileContent: '',
        fileType: 'qif' as const,
        parsedData: {
          transactions: [],
          investmentTransactions: [],
          qifType: 'Bank' as const,
          accountType: 'INVESTMENT',
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
        matchConfidence: 'exact' as const,
      },
    ];
    render(<CompleteStep {...defaultProps} importFiles={importFiles} />);
    expect(screen.getByText(/View Investments/i)).toBeInTheDocument();
  });

  // --- View destination navigation (issue #911) ---

  it('navigates to the just-imported account, not the last-viewed one', () => {
    render(
      <CompleteStep
        {...defaultProps}
        importFiles={[createImportFile('b.qif', 'acc-1')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1');
  });

  it('falls back to the selectedAccountId when importFiles is empty', () => {
    render(<CompleteStep {...defaultProps} selectedAccountId="acc-1" />);
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1');
  });

  it('filters to every account touched by a bulk import', () => {
    const accounts = [
      createAccount({ id: 'acc-1', name: 'Chequing' }),
      createAccount({ id: 'acc-2', name: 'Savings' }),
    ];
    render(
      <CompleteStep
        {...defaultProps}
        accounts={accounts}
        importResult={null}
        isBulkImport
        bulkImportResult={{
          totalImported: 5, totalSkipped: 0, totalErrors: 0,
          categoriesCreated: 0, accountsCreated: 0, payeesCreated: 0, securitiesCreated: 0,
          fileResults: [],
        }}
        importFiles={[
          createImportFile('checking.qif', 'acc-1'),
          createImportFile('savings.qif', 'acc-2'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    const url = mockPush.mock.calls[0][0] as string;
    expect(url.startsWith('/transactions?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('accountIds')).toBe('acc-1,acc-2');
  });

  it('deduplicates accounts when a bulk import targets one account twice', () => {
    render(
      <CompleteStep
        {...defaultProps}
        importResult={null}
        isBulkImport
        bulkImportResult={{
          totalImported: 5, totalSkipped: 0, totalErrors: 0,
          categoriesCreated: 0, accountsCreated: 0, payeesCreated: 0, securitiesCreated: 0,
          fileResults: [],
        }}
        importFiles={[
          createImportFile('jan.qif', 'acc-1'),
          createImportFile('feb.qif', 'acc-1'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1');
  });

  it('forces the Show Accounts filter to All for a closed target account', () => {
    render(
      <CompleteStep
        {...defaultProps}
        accounts={[createAccount({ id: 'acc-1', isClosed: true })]}
        importFiles={[createImportFile('b.qif', 'acc-1')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1&accountStatus=all');
  });

  it('filters investments to the imported brokerage account', () => {
    render(
      <CompleteStep
        {...defaultProps}
        importFiles={[createImportFile('portfolio.qif', 'brokerage-1', 'INVESTMENT')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Investments/i }));
    expect(mockPush).toHaveBeenCalledWith('/investments?accountId=brokerage-1');
  });

  it('filters to accounts created by a multi-account QIF import', () => {
    render(
      <CompleteStep
        {...defaultProps}
        importFiles={[]}
        selectedAccountId=""
        importResult={{
          imported: 20, skipped: 0, errors: 0, errorMessages: [],
          categoriesCreated: 0, accountsCreated: 2, payeesCreated: 0, securitiesCreated: 0,
          createdMappings: {
            categories: {},
            accounts: { Chequing: 'acc-1' },
            loans: {},
            securities: {},
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /View Transactions/i }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1');
  });

  // --- Bulk import results ---

  it('shows bulk import overall summary', () => {
    const bulkResult = {
      totalImported: 50,
      totalSkipped: 5,
      totalErrors: 1,
      categoriesCreated: 3,
      accountsCreated: 1,
      payeesCreated: 10,
      securitiesCreated: 0,
      fileResults: [
        {
          fileName: 'checking.qif',
          accountName: 'My Chequing',
          imported: 30,
          skipped: 3,
          errors: 0,
          errorMessages: [],
        },
        {
          fileName: 'savings.qif',
          accountName: 'My Savings',
          imported: 20,
          skipped: 2,
          errors: 1,
          errorMessages: ['Row 3: bad date'],
        },
      ],
    };
    render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResult}
      />
    );
    expect(screen.getByText('Overall Summary')).toBeInTheDocument();
    expect(screen.getByText(/50 transactions/)).toBeInTheDocument();
    expect(screen.getByText(/5 duplicate transfers/)).toBeInTheDocument();
    expect(screen.getByText('Per-File Results')).toBeInTheDocument();
    expect(screen.getByText('checking.qif')).toBeInTheDocument();
    expect(screen.getByText('savings.qif')).toBeInTheDocument();
  });

  it('shows per-file error messages in bulk import', () => {
    const bulkResult = {
      totalImported: 10,
      totalSkipped: 0,
      totalErrors: 2,
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      fileResults: [
        {
          fileName: 'bad.qif',
          accountName: 'Chequing',
          imported: 8,
          skipped: 0,
          errors: 2,
          errorMessages: ['Error 1', 'Error 2'],
        },
      ],
    };
    render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResult}
      />
    );
    expect(screen.getByText('Error 1')).toBeInTheDocument();
    expect(screen.getByText('Error 2')).toBeInTheDocument();
  });

  it('truncates error messages at 3 with a "more" message', () => {
    const bulkResult = {
      totalImported: 10,
      totalSkipped: 0,
      totalErrors: 5,
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      fileResults: [
        {
          fileName: 'bad.qif',
          accountName: 'Chequing',
          imported: 5,
          skipped: 0,
          errors: 5,
          errorMessages: ['Err 1', 'Err 2', 'Err 3', 'Err 4', 'Err 5'],
        },
      ],
    };
    render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResult}
      />
    );
    expect(screen.getByText('Err 1')).toBeInTheDocument();
    expect(screen.getByText('Err 2')).toBeInTheDocument();
    expect(screen.getByText('Err 3')).toBeInTheDocument();
    expect(screen.getByText(/2 more errors/)).toBeInTheDocument();
    expect(screen.queryByText('Err 4')).not.toBeInTheDocument();
  });

  it('uses wider container for bulk import', () => {
    const bulkResult = {
      totalImported: 10,
      totalSkipped: 0,
      totalErrors: 0,
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      fileResults: [],
    };
    const { container } = render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResult}
      />
    );
    expect(container.firstElementChild?.className).toContain('max-w-4xl');
  });

  it('does not show single import result when bulkImportResult is present', () => {
    const bulkResult = {
      totalImported: 10,
      totalSkipped: 0,
      totalErrors: 0,
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      fileResults: [],
    };
    render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResult}
        importResult={{
          imported: 10,
          skipped: 0,
          errors: 0,
          errorMessages: [],
          categoriesCreated: 0,
          accountsCreated: 0,
          payeesCreated: 0,
          securitiesCreated: 0,
        }}
      />
    );
    // Should not show single-file format fields
    expect(screen.queryByText('Target Account:')).not.toBeInTheDocument();
  });

  // --- Loan account setup tests ---

  it('shows "Import Complete" heading', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText('Import Complete')).toBeInTheDocument();
  });

  it('shows import result summary for single file import', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.getByText(/test\.qif/)).toBeInTheDocument();
    expect(screen.getByText(/10 transactions/)).toBeInTheDocument();
    expect(screen.getByText(/2 duplicate transfers/)).toBeInTheDocument();
  });

  it('shows loan accounts needing setup when present in importResult', () => {
    const resultWithLoans = {
      ...defaultProps.importResult!,
      loanAccountsNeedingSetup: [
        { accountId: 'loan-1', accountName: 'Home Mortgage', accountType: 'MORTGAGE' },
        { accountId: 'loan-2', accountName: 'Car Loan', accountType: 'LOAN' },
      ],
    };
    render(<CompleteStep {...defaultProps} importResult={resultWithLoans} />);

    expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
    expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
  });

  it('shows "Set Up Payments" button for each pending loan account', () => {
    const resultWithLoans = {
      ...defaultProps.importResult!,
      loanAccountsNeedingSetup: [
        { accountId: 'loan-1', accountName: 'Home Mortgage', accountType: 'MORTGAGE' },
        { accountId: 'loan-2', accountName: 'Car Loan', accountType: 'LOAN' },
      ],
    };
    render(<CompleteStep {...defaultProps} importResult={resultWithLoans} />);

    const setupButtons = screen.getAllByRole('button', { name: /Set Up Payments/i });
    expect(setupButtons).toHaveLength(2);
  });

  it('does not show loan setup section when no loan accounts need setup', () => {
    render(<CompleteStep {...defaultProps} />);
    expect(screen.queryByText('Set Up Recurring Payments')).not.toBeInTheDocument();
  });

  it('opens loan payment setup dialog when "Set Up Payments" is clicked', () => {
    const resultWithLoans = {
      ...defaultProps.importResult!,
      loanAccountsNeedingSetup: [
        { accountId: 'loan-1', accountName: 'Home Mortgage', accountType: 'MORTGAGE' },
      ],
    };
    render(<CompleteStep {...defaultProps} importResult={resultWithLoans} />);

    // Click the setup button to open the dialog
    const setupButton = screen.getByRole('button', { name: /Set Up Payments/i });
    fireEvent.click(setupButton);

    // The dialog should now be open
    expect(screen.getByTestId('loan-payment-setup-dialog')).toBeInTheDocument();
  });

  describe('seeds the dialog with the type of the account', () => {
    const openFor = (account: Account, accountId = account.id) => {
      const resultWithLoans = {
        ...defaultProps.importResult!,
        loanAccountsNeedingSetup: [
          { accountId, accountName: account.name, accountType: 'MORTGAGE' },
        ],
      };
      render(
        <CompleteStep
          {...defaultProps}
          accounts={[account]}
          importResult={resultWithLoans}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Set Up Payments/i }));
      const dialog = screen.getByTestId('loan-payment-setup-dialog');
      return dialog.dataset.mortgageType;
    };

    it.each(['CANADIAN_FIXED', 'ANNUITY'] as const)('seeds the stored %s type', (type) => {
      expect(
        openFor(
          createAccount({
            id: 'loan-1',
            accountType: 'MORTGAGE',
            mortgageType: type,
          }),
        ),
      ).toBe(type);
    });

    it('passes no type for an account it cannot find', () => {
      expect(openFor(createAccount({ id: 'loan-1' }), 'loan-2')).toBe('undefined');
    });
  });

  it('closes loan payment setup dialog when close button clicked', () => {
    const resultWithLoans = {
      ...defaultProps.importResult!,
      loanAccountsNeedingSetup: [
        { accountId: 'loan-1', accountName: 'Home Mortgage', accountType: 'MORTGAGE' },
      ],
    };
    render(<CompleteStep {...defaultProps} importResult={resultWithLoans} />);

    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: /Set Up Payments/i }));
    expect(screen.getByTestId('loan-payment-setup-dialog')).toBeInTheDocument();

    // Close dialog
    fireEvent.click(screen.getByTestId('close-dialog'));
    expect(screen.queryByTestId('loan-payment-setup-dialog')).not.toBeInTheDocument();
  });

  it('shows completion message after setup is done', () => {
    const resultWithLoans = {
      ...defaultProps.importResult!,
      loanAccountsNeedingSetup: [
        { accountId: 'loan-1', accountName: 'Home Mortgage', accountType: 'MORTGAGE' },
      ],
    };
    render(<CompleteStep {...defaultProps} importResult={resultWithLoans} />);

    // Open dialog and complete setup
    fireEvent.click(screen.getByRole('button', { name: /Set Up Payments/i }));
    fireEvent.click(screen.getByTestId('setup-complete'));

    // Should show completed setups message
    expect(screen.getByText(/Scheduled payments configured for 1 account\./)).toBeInTheDocument();
  });

  it('shows loan accounts from bulkImportResult', () => {
    const bulkResultWithLoans = {
      totalImported: 10,
      totalSkipped: 0,
      totalErrors: 0,
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      fileResults: [
        {
          fileName: 'mortgage.qif',
          accountName: 'Home Mortgage',
          imported: 10,
          skipped: 0,
          errors: 0,
          errorMessages: [],
          loanAccountsNeedingSetup: [
            { accountId: 'loan-file-1', accountName: 'File Loan', accountType: 'LOAN' },
          ],
        },
      ],
      loanAccountsNeedingSetup: [
        { accountId: 'bulk-loan-1', accountName: 'Bulk Mortgage', accountType: 'MORTGAGE' },
      ],
    };
    render(
      <CompleteStep
        {...defaultProps}
        isBulkImport={true}
        bulkImportResult={bulkResultWithLoans}
      />
    );

    expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
    expect(screen.getByText('Bulk Mortgage')).toBeInTheDocument();
    expect(screen.getByText('File Loan')).toBeInTheDocument();
  });
});
