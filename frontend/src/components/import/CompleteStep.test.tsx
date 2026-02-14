import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CompleteStep } from './CompleteStep';
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
        parsedData: {
          transactions: [],
          investmentTransactions: [],
          qifType: 'Bank' as const,
          accountType: 'INVESTMENT',
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
        matchConfidence: 'exact',
      },
    ];
    render(<CompleteStep {...defaultProps} importFiles={importFiles} />);
    expect(screen.getByText(/View Investments/i)).toBeInTheDocument();
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
});
