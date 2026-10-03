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
    institution: null, institutionId: null,
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
    interestBookingMode: 'AUTO',
    overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
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

  it('renders the wiki notice banner with links to both import guides', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.getByText('Before you import')).toBeInTheDocument();

    const moneyLink = screen.getByRole('link', { name: 'Importing from Microsoft Money' });
    expect(moneyLink).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/wiki/Importing-from-Microsoft-Money'
    );
    expect(moneyLink).toHaveAttribute('target', '_blank');
    expect(moneyLink).toHaveAttribute('rel', 'noopener noreferrer');

    const quickenLink = screen.getByRole('link', { name: 'Importing from Quicken' });
    expect(quickenLink).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/wiki/Importing-from-Quicken'
    );
    expect(quickenLink).toHaveAttribute('target', '_blank');
    expect(quickenLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders file input with correct accept attribute', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.accept).toBe('.qif,.ofx,.qfx,.csv,.mny');
    expect(input.multiple).toBe(true);
  });

  // `.mny` was accepted by the input above for three phases while the
  // "Supported formats" sentence still read "QIF, OFX/QFX, CSV" -- the format
  // was supported and undiscoverable. `messages.import-formats.test.ts` is the
  // guard that keeps the accept list and the catalogs in step, in every locale;
  // this one only asserts the copy reaches the screen.
  it('tells the user a Microsoft Money file is accepted', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} />);

    expect(screen.getByText(/Supported formats/)).toHaveTextContent(
      'Microsoft Money (.mny)',
    );
    expect(
      screen.getByText(/QIF, OFX, QFX, CSV, or Microsoft Money \(\.mny\)/),
    ).toBeInTheDocument();
  });

  describe('when a Microsoft Money file would not open', () => {
    it('says nothing while there is nothing to say', () => {
      render(
        <UploadStep
          preselectedAccount={undefined}
          isLoading={false}
          onFileSelect={onFileSelect}
        />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the reason, because the wizard goes nowhere else', () => {
      // The regression: a .mny that failed to parse left the user on this step
      // with no message at all, so the file simply appeared to do nothing.
      render(
        <UploadStep
          preselectedAccount={undefined}
          isLoading={false}
          onFileSelect={onFileSelect}
          mnyError={{
            code: 'mnyUnsupportedVersion',
            message:
              'That file was written by Money 97 or 98. Open and save it once in the free Money Plus Sunset edition.',
          }}
        />,
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'That Microsoft Money file could not be opened',
      );
      // The instruction is the useful half, which is why this is a panel and
      // not a toast that takes it away mid-sentence.
      expect(alert).toHaveTextContent(/Money Plus Sunset edition/);
    });

    it('falls back to generic copy when the backend sent no message', () => {
      render(
        <UploadStep
          preselectedAccount={undefined}
          isLoading={false}
          onFileSelect={onFileSelect}
          mnyError={{ message: '' }}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not be read/,
      );
    });
  });
});
