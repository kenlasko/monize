import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, fireEvent } from '@testing-library/react';
import { UploadStep } from './UploadStep';
import { Account } from '@/types/account';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({ default: { error: toastError } }));

/** A drag payload as the browser hands it to the drop zone. */
function fileDrag(files: File[]) {
  return { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } };
}

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
  const onFilesDrop = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the upload heading and instructions', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText(/Upload Transaction Files/)).toBeInTheDocument();
    expect(screen.getByText(/Select one or more files to import/)).toBeInTheDocument();
  });

  it('shows "Click to select file(s)" when not loading', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText('Click to select file(s)')).toBeInTheDocument();
  });

  it('shows "Processing..." when isLoading is true', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={true} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText('Processing...')).toBeInTheDocument();
    expect(screen.queryByText('Click to select file(s)')).not.toBeInTheDocument();
  });

  it('disables the file input when isLoading is true', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={true} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('displays preselected account info when provided', () => {
    const account = createAccount({ name: 'My Savings', accountType: 'SAVINGS' });
    render(<UploadStep preselectedAccount={account} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText(/Importing to:/)).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
  });

  it('does not display preselected account info when not provided', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.queryByText(/Importing to:/)).not.toBeInTheDocument();
  });

  it('calls onFileSelect when a file is selected', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['content'], 'test.qif')] } });
    expect(onFileSelect).toHaveBeenCalledTimes(1);
  });

  it('renders the documentation notice banner with links to both import guides', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText('Before you import')).toBeInTheDocument();

    const moneyLink = screen.getByRole('link', { name: 'Importing from Microsoft Money' });
    expect(moneyLink).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/importing-from-microsoft-money'
    );
    expect(moneyLink).toHaveAttribute('target', '_blank');
    expect(moneyLink).toHaveAttribute('rel', 'noopener noreferrer');

    const quickenLink = screen.getByRole('link', { name: 'Importing from Quicken' });
    expect(quickenLink).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/importing-from-quicken'
    );
    expect(quickenLink).toHaveAttribute('target', '_blank');
    expect(quickenLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders file input with correct accept attribute', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.accept).toBe('.qif,.qmtf,.ofx,.qfx,.csv,.mny');
    expect(input.multiple).toBe(true);
  });

  // `.mny` was accepted by the input above for three phases while the
  // "Supported formats" sentence still read "QIF, OFX/QFX, CSV" -- the format
  // was supported and undiscoverable. `messages.import-formats.test.ts` is the
  // guard that keeps the accept list and the catalogs in step, in every locale;
  // this one only asserts the copy reaches the screen.
  it('tells the user a Microsoft Money file is accepted', () => {
    render(<UploadStep preselectedAccount={undefined} isLoading={false} onFileSelect={onFileSelect} onFilesDrop={onFilesDrop} />);

    expect(screen.getByText(/Supported formats/)).toHaveTextContent(
      'Microsoft Money (.mny)',
    );
    expect(
      screen.getByText(/QIF\/QMTF, OFX, QFX, CSV, or Microsoft Money \(\.mny\)/),
    ).toBeInTheDocument();
  });

  describe('when a Microsoft Money file would not open', () => {
    it('says nothing while there is nothing to say', () => {
      render(
        <UploadStep
          preselectedAccount={undefined}
          isLoading={false}
          onFileSelect={onFileSelect}
          onFilesDrop={onFilesDrop}
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
          onFilesDrop={onFilesDrop}
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
          onFilesDrop={onFilesDrop}
          mnyError={{ message: '' }}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not be read/,
      );
    });
  });

  describe('drag and drop', () => {
    const renderStep = (isLoading = false) =>
      render(
        <UploadStep
          preselectedAccount={undefined}
          isLoading={isLoading}
          onFileSelect={onFileSelect}
          onFilesDrop={onFilesDrop}
        />,
      );

    it('tells the user files can be dropped', () => {
      renderStep();

      expect(screen.getByText('or drag and drop them here')).toBeInTheDocument();
    });

    it('highlights the zone while files are dragged over it', () => {
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');
      const qif = new File(['!Type:Bank'], 'bank.qif');

      fireEvent.dragEnter(zone, fileDrag([qif]));
      expect(screen.getByText('Drop to import')).toBeInTheDocument();
      expect(zone.className).toContain('border-blue-500');

      fireEvent.dragLeave(zone, fileDrag([qif]));
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
      expect(screen.getByText('Click to select file(s)')).toBeInTheDocument();
    });

    it('keeps the highlight while the pointer crosses a child element', () => {
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');
      const qif = new File(['!Type:Bank'], 'bank.qif');

      fireEvent.dragEnter(zone, fileDrag([qif]));
      fireEvent.dragEnter(zone, fileDrag([qif]));
      fireEvent.dragLeave(zone, fileDrag([qif]));

      expect(screen.getByText('Drop to import')).toBeInTheDocument();
    });

    it('hands every dropped file to the wizard', () => {
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');
      const files = [
        new File(['a'], 'chequing.QIF'),
        new File(['b'], 'savings.qif'),
      ];

      fireEvent.dragEnter(zone, fileDrag(files));
      fireEvent.drop(zone, fileDrag(files));

      expect(onFilesDrop).toHaveBeenCalledTimes(1);
      expect(onFilesDrop).toHaveBeenCalledWith(files);
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
      expect(toastError).not.toHaveBeenCalled();
    });

    it('refuses a drop holding a file the picker would not offer', () => {
      // The picker filters by `accept`; a drop does not, and the wizard reads
      // any unknown extension as QIF.
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');
      const files = [
        new File(['a'], 'chequing.qif'),
        new File(['%PDF'], 'statement.pdf'),
      ];

      fireEvent.drop(zone, fileDrag(files));

      expect(onFilesDrop).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('statement.pdf'),
      );
      expect(toastError).toHaveBeenCalledWith(
        expect.not.stringContaining('chequing.qif'),
      );
    });

    it('still claims a file drag while loading so the browser cannot open the file', () => {
      // Without preventDefault on dragover the browser never fires drop and
      // instead navigates the tab to the released file, mid-upload.
      renderStep(true);
      const zone = screen.getByTestId('import-drop-zone');
      const drag = fileDrag([new File(['a'], 'bank.qif')]);

      const enterAllowed = fireEvent.dragEnter(zone, drag);
      const overAllowed = fireEvent.dragOver(zone, drag);

      // fireEvent returns false when the handler called preventDefault.
      expect(enterAllowed).toBe(false);
      expect(overAllowed).toBe(false);
    });

    it('offers a copy drop when idle', () => {
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');

      expect(
        fireEvent.dragOver(zone, fileDrag([new File(['a'], 'bank.qif')])),
      ).toBe(false);
    });

    it('ignores a drop while a file is already being processed', () => {
      renderStep(true);
      const zone = screen.getByTestId('import-drop-zone');

      fireEvent.dragEnter(zone, fileDrag([new File(['a'], 'bank.qif')]));
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();

      fireEvent.drop(zone, fileDrag([new File(['a'], 'bank.qif')]));
      expect(onFilesDrop).not.toHaveBeenCalled();
    });

    it('ignores a drag that carries no files', () => {
      renderStep();
      const zone = screen.getByTestId('import-drop-zone');

      fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'], files: [] } });

      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
    });
  });
});
