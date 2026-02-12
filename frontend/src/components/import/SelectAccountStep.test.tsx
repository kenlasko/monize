import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
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

  it('shows Back button', () => {
    render(<SelectAccountStep {...defaultProps} />);

    const backButton = screen.getByRole('button', { name: /Back/i });
    expect(backButton).toBeInTheDocument();
  });

  it('shows create new account button', () => {
    render(<SelectAccountStep {...defaultProps} />);

    expect(screen.getByText('+ Create new account')).toBeInTheDocument();
  });
});
