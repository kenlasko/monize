import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, fireEvent } from '@testing-library/react';
import { UploadStep } from './UploadStep';
import { Account } from '@/types/account';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'My Chequing',
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 1000,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    favouriteSortOrder: 0,
    excludeFromNetWorth: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    statementDueDay: null,
    statementSettlementDay: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('UploadStep', () => {
  const onFileSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the upload heading and instructions', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.getByText(/Upload Transaction Files/)).toBeInTheDocument();
    expect(screen.getByText(/Select one or more files to import/)).toBeInTheDocument();
  });

  it('shows "Click to select file(s)" when not loading', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.getByText('Click to select file(s)')).toBeInTheDocument();
  });

  it('shows "Processing..." when isLoading is true', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={true} onFileSelect={onFileSelect} />);

    expect(screen.getByText('Processing...')).toBeInTheDocument();
    expect(screen.queryByText('Click to select file(s)')).not.toBeInTheDocument();
  });

  it('disables the file input when isLoading is true', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={true} onFileSelect={onFileSelect} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('displays preselected account info when provided', () => {
    const account = createAccount({ name: 'My Savings', accountType: 'SAVINGS' });
    render(<UploadStep preselectedAccount={account} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.getByText(/Importing to:/)).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
  });

  it('does not display preselected account info when not provided', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.queryByText(/Importing to:/)).not.toBeInTheDocument();
  });

  it('calls onFileSelect when a file is selected', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['content'], 'test.qif')] } });
    expect(onFileSelect).toHaveBeenCalledTimes(1);
  });

  it('renders file input with correct accept attribute', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.accept).toBe('.qif,.ofx,.qfx,.csv');
    expect(input.multiple).toBe(true);
  });
});
