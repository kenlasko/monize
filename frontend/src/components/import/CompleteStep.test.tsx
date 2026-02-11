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
});
