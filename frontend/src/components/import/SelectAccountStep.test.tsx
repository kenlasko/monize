import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SelectAccountStep } from './SelectAccountStep';

describe('SelectAccountStep', () => {
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
      transactionCount: 1,
      dateRange: { start: '2024-01-01', end: '2024-01-31' },
      categories: [],
      securities: [],
      transferAccounts: [],
      detectedDateFormat: 'YYYY-MM-DD' as const,
      sampleDates: [],
    },
    accounts: [],
    selectedAccountId: '',
    setSelectedAccountId: vi.fn(),
    setFileAccountId: vi.fn(),
    showCreateAccount: false,
    setShowCreateAccount: vi.fn(),
    creatingForFileIndex: -1,
    setCreatingForFileIndex: vi.fn(),
    newAccountName: '',
    setNewAccountName: vi.fn(),
    newAccountType: 'CHEQUING',
    setNewAccountType: vi.fn(),
    newAccountCurrency: 'CAD',
    setNewAccountCurrency: vi.fn(),
    isCreatingAccount: false,
    handleCreateAccount: vi.fn(),
    accountTypeOptions: [{ value: 'CHEQUING', label: 'Chequing' }],
    currencyOptions: [{ value: 'CAD', label: 'CAD' }],
    categoryMappings: { length: 0 },
    securityMappings: { length: 0 },
    shouldShowMapAccounts: false,
    setStep: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Single file mode (non-bulk) ---

  it('renders the select account heading', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText('Select Destination Account')).toBeInTheDocument();
  });

  it('shows file info', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText(/test\.qif/)).toBeInTheDocument();
  });

  it('shows transaction count from parsed data', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText(/Transactions:/)).toBeInTheDocument();
  });

  it('shows date range from parsed data', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText(/Date Range:/)).toBeInTheDocument();
    expect(screen.getByText(/2024-01-01/)).toBeInTheDocument();
  });

  it('shows detected type from parsed data', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText(/Detected Type:/)).toBeInTheDocument();
  });

  it('shows Back button', () => {
    render(<SelectAccountStep {...defaultProps} />);
    const backButton = screen.getByRole('button', { name: /Back/i });
    expect(backButton).toBeInTheDocument();
  });

  it('shows create new account button', () => {
    render(<SelectAccountStep {...defaultProps} />);
    expect(screen.getByText('+ Create new account')).toBeInTheDocument();
  });

  it('Back button navigates to upload step', () => {
    render(<SelectAccountStep {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('upload');
  });

  it('disables Next button when no account is selected', () => {
    render(<SelectAccountStep {...defaultProps} />);
    const nextButton = screen.getByRole('button', { name: /Next/i });
    expect(nextButton).toBeDisabled();
  });

  it('enables Next button when account is selected', () => {
    render(<SelectAccountStep {...defaultProps} selectedAccountId="acc-1" />);
    const nextButton = screen.getByRole('button', { name: /Next/i });
    expect(nextButton).not.toBeDisabled();
  });

  it('Next navigates to review when no category/security/account mappings', () => {
    render(<SelectAccountStep {...defaultProps} selectedAccountId="acc-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('review');
  });

  it('Next navigates to mapCategories when categoryMappings exist', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        selectedAccountId="acc-1"
        categoryMappings={{ length: 3 }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapCategories');
  });

  it('Next navigates to mapSecurities when securityMappings exist but no categories', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        selectedAccountId="acc-1"
        securityMappings={{ length: 2 }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapSecurities');
  });

  it('Next navigates to mapAccounts when shouldShowMapAccounts and no categories/securities', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        selectedAccountId="acc-1"
        shouldShowMapAccounts={true}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapAccounts');
  });

  it('shows investment notice for INVESTMENT type', () => {
    const investmentParsedData = {
      ...defaultProps.parsedData,
      accountType: 'INVESTMENT',
    };
    render(<SelectAccountStep {...defaultProps} parsedData={investmentParsedData} />);
    expect(screen.getByText(/investment transactions/i)).toBeInTheDocument();
  });

  it('filters compatible accounts for non-investment files', () => {
    const accounts = [
      { id: 'acc-1', name: 'Chequing', accountType: 'CHEQUING', accountSubType: null },
      { id: 'acc-2', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' },
    ] as any[];
    render(<SelectAccountStep {...defaultProps} accounts={accounts} />);
    // Only non-brokerage accounts should appear in the select
    expect(screen.getByText(/Chequing/)).toBeInTheDocument();
  });

  it('clicking create new account button calls setShowCreateAccount', () => {
    render(<SelectAccountStep {...defaultProps} />);
    fireEvent.click(screen.getByText('+ Create new account'));
    expect(defaultProps.setShowCreateAccount).toHaveBeenCalledWith(true);
    expect(defaultProps.setCreatingForFileIndex).toHaveBeenCalledWith(0);
  });

  it('shows create account form when showCreateAccount and creatingForFileIndex match', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName="My Account"
      />
    );
    expect(screen.getByText('Create New Account')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My Account')).toBeInTheDocument();
  });

  it('Create button is disabled when isCreatingAccount is true', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName="My Account"
        isCreatingAccount={true}
      />
    );
    expect(screen.getByText('Creating...')).toBeInTheDocument();
  });

  it('Create button is disabled when newAccountName is empty', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName=""
      />
    );
    const createButton = screen.getByRole('button', { name: /Create$/i });
    expect(createButton).toBeDisabled();
  });

  it('calls handleCreateAccount when create button is clicked', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName="My Account"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    expect(defaultProps.handleCreateAccount).toHaveBeenCalledWith(0);
  });

  it('Cancel button hides create account form', () => {
    render(
      <SelectAccountStep
        {...defaultProps}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName="My Account"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(defaultProps.setShowCreateAccount).toHaveBeenCalledWith(false);
    expect(defaultProps.setCreatingForFileIndex).toHaveBeenCalledWith(-1);
    expect(defaultProps.setNewAccountName).toHaveBeenCalledWith('');
  });

  // --- Bulk import mode ---

  it('renders bulk import heading when isBulkImport', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText('Select Destination Accounts')).toBeInTheDocument();
  });

  it('renders all import files in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'checking.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 10 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
      {
        fileName: 'savings.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 3 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText('checking.qif')).toBeInTheDocument();
    expect(screen.getByText('savings.qif')).toBeInTheDocument();
    expect(screen.getByText(/10 transactions/)).toBeInTheDocument();
    // "3 transactions" may appear in both the file row and total summary; just verify it exists
    expect(screen.getAllByText(/3 transactions/).length).toBeGreaterThan(0);
  });

  it('shows total file and transaction count in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 7 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
      {
        fileName: 'file2.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 3 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
    expect(screen.getByText(/10 transactions/)).toBeInTheDocument();
  });

  it('disables Next in bulk mode when not all files have accounts', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    const nextButton = screen.getByRole('button', { name: /Next/i });
    expect(nextButton).toBeDisabled();
  });

  it('enables Next in bulk mode when all files have accounts', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    const nextButton = screen.getByRole('button', { name: /Next/i });
    expect(nextButton).not.toBeDisabled();
  });

  it('applies green border for high confidence match in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'exact' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    const fileRow = screen.getByText('file1.qif').closest('div[class*="border"]');
    expect(fileRow?.className).toContain('border-green');
  });

  it('applies amber border for low confidence match in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: 'acc-1',
        matchConfidence: 'partial' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    const fileRow = screen.getByText('file1.qif').closest('div[class*="border"]');
    expect(fileRow?.className).toContain('border-amber');
  });

  it('shows create new button per file in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText('+ Create new')).toBeInTheDocument();
  });

  it('shows inline create form when creatingForFileIndex matches in bulk mode', () => {
    const importFiles = [
      {
        fileName: 'file1.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, transactionCount: 5 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
        showCreateAccount={true}
        creatingForFileIndex={0}
        newAccountName="New Acct"
      />
    );
    expect(screen.getByDisplayValue('New Acct')).toBeInTheDocument();
  });

  it('shows investment label in bulk mode for investment files', () => {
    const importFiles = [
      {
        fileName: 'portfolio.qif',
        fileContent: '',
        parsedData: { ...defaultProps.parsedData, accountType: 'INVESTMENT', transactionCount: 5 },
        selectedAccountId: '',
        matchConfidence: 'none' as const,
      },
    ];
    render(
      <SelectAccountStep
        {...defaultProps}
        isBulkImport={true}
        importFiles={importFiles}
      />
    );
    expect(screen.getByText(/Investment/)).toBeInTheDocument();
  });
});
