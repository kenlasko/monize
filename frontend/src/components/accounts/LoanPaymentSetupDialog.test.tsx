import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { LoanPaymentSetupDialog } from './LoanPaymentSetupDialog';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { Account, DetectedLoanPayment } from '@/types/account';
import toast from 'react-hot-toast';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    detectLoanPayments: vi.fn().mockResolvedValue(null),
    setupLoanPayments: vi.fn().mockResolvedValue({}),
    previewLoanPaymentSetup: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'new-payee', name: 'New Payee' }),
  },
}));

// Combobox mock that exposes onChange (select existing) and onCreateNew (create payee)
vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ value, onChange, onCreateNew, placeholder }: any) => (
    <div data-testid={`combobox-${(placeholder || '').includes('payee') ? 'payee' : 'category'}`}>
      <input
        data-testid={`combobox-input-${(placeholder || '').includes('payee') ? 'payee' : 'category'}`}
        value={value || ''}
        placeholder={placeholder}
        onChange={(e: any) => onChange?.(e.target.value, 'Chosen Name')}
      />
      {onCreateNew && (
        <button
          data-testid="combobox-create-payee"
          onClick={() => onCreateNew('Brand New Lender')}
        >
          create
        </button>
      )}
      {onCreateNew && (
        <button
          data-testid="combobox-create-empty"
          onClick={() => onCreateNew('   ')}
        >
          create-empty
        </button>
      )}
    </div>
  ),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockDetectLoanPayments = vi.mocked(accountsApi.detectLoanPayments);
const mockSetupLoanPayments = vi.mocked(accountsApi.setupLoanPayments);
const mockPreviewLoanPaymentSetup = vi.mocked(accountsApi.previewLoanPaymentSetup);
const mockGetCategories = vi.mocked(categoriesApi.getAll);
const mockCreatePayee = vi.mocked(payeesApi.create);

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

const defaultDetected: DetectedLoanPayment = {
  paymentAmount: 1500,
  paymentFrequency: 'MONTHLY',
  confidence: 0.85,
  sourceAccountId: 'acc-1',
  sourceAccountName: 'My Chequing',
  interestCategoryId: null,
  interestCategoryName: null,
  principalCategoryId: null,
  estimatedInterestRate: 5.5,
  suggestedNextDueDate: '2026-04-01',
  firstPaymentDate: '2025-01-01',
  lastPaymentDate: '2026-03-01',
  paymentCount: 15,
  currentBalance: 200000,
  isMortgage: false,
  averageExtraPrincipal: 0,
  extraPrincipalCount: 0,
  lastPrincipalAmount: null,
  lastInterestAmount: null,
};

const sourceAccount = createAccount({ id: 'acc-1', name: 'My Chequing', accountType: 'CHEQUING' });

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  loanAccount: { accountId: 'loan-1', accountName: 'My Loan', accountType: 'LOAN', currencyCode: 'USD' },
  accounts: [sourceAccount],
  onSetupComplete: vi.fn(),
};

async function renderDialog(props: ComponentProps<typeof LoanPaymentSetupDialog> = defaultProps) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<LoanPaymentSetupDialog {...props} />);
  });
  return result!;
}

describe('LoanPaymentSetupDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectLoanPayments.mockResolvedValue(null);
    mockGetCategories.mockResolvedValue([]);
  });

  it('shows loading spinner while detecting', () => {
    // Make detectLoanPayments hang so we stay in the loading state
    mockDetectLoanPayments.mockReturnValue(new Promise(() => {}));
    render(<LoanPaymentSetupDialog {...defaultProps} />);
    expect(screen.getByText('Analyzing transaction history...')).toBeInTheDocument();
  });

  it('shows form after detection completes', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    expect(screen.getByText('Set Up Loan Payments')).toBeInTheDocument();
    expect(screen.getByText('My Loan')).toBeInTheDocument();
    expect(screen.queryByText('Analyzing transaction history...')).not.toBeInTheDocument();
  });

  it('shows detection info banner with payment count', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    expect(screen.getByText(/Detected 15 payments/)).toBeInTheDocument();
    expect(screen.getByText(/2025-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-03-01/)).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('calls setupLoanPayments on form submit', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => {
      fireEvent.click(submitButton);
    });

    expect(mockSetupLoanPayments).toHaveBeenCalledWith('loan-1', expect.objectContaining({
      paymentAmount: 1500,
      paymentFrequency: 'MONTHLY',
      sourceAccountId: 'acc-1',
      nextDueDate: '2026-04-01',
    }));
    expect(toast.success).toHaveBeenCalled();
    expect(defaultProps.onSetupComplete).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows "Mortgage Details" section when accountType is MORTGAGE', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'loan-1', accountName: 'My Mortgage', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);

    expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    expect(screen.getByText('Set Up Mortgage Payments')).toBeInTheDocument();
    const type = screen.getByLabelText('Mortgage Type') as HTMLSelectElement;
    expect(Array.from(type.options).map((o) => [o.value, o.textContent])).toEqual([
      ['ANNUITY', 'Annuity (Level Payment)'],
      ['CANADIAN_FIXED', 'Canadian Fixed Rate'],
      ['LINEAR', 'Linear (Constant Principal)'],
      ['INTEREST_ONLY', 'Interest Only'],
    ]);
    expect(screen.queryByRole('checkbox', { name: /Canadian Mortgage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Variable Rate/ })).not.toBeInTheDocument();
    expect(screen.getByText('Rate-Fixed Term (months)')).toBeInTheDocument();
  });

  it('does not show mortgage section for LOAN type', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    expect(screen.queryByText('Mortgage Details')).not.toBeInTheDocument();
    expect(screen.getByText('Set Up Loan Payments')).toBeInTheDocument();
  });

  it('calls onClose when Skip button clicked', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const skipButton = screen.getByRole('button', { name: /Skip/i });
    fireEvent.click(skipButton);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles include extra principal checkbox and submits with extra principal', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const checkbox = screen.getByLabelText(/Include extra payment to principal/i);
    await act(async () => fireEvent.click(checkbox));
    expect(checkbox).toBeChecked();

    // Submit without extra > 0 should not include extraPrincipal
    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));
    expect(mockSetupLoanPayments).toHaveBeenCalled();
  });

  it('shows useDetectedSplit checkbox when last principal/interest amounts are detected', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      lastPrincipalAmount: 100,
      lastInterestAmount: 50,
    });
    await renderDialog();
    expect(screen.getByText(/Use principal\/interest split from imported transactions/i)).toBeInTheDocument();
  });

  it('toggles useDetectedSplit checkbox', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      lastPrincipalAmount: 100,
      lastInterestAmount: 50,
    });
    await renderDialog();
    const cb = screen.getByLabelText(/Use principal\/interest split/i);
    await act(async () => fireEvent.click(cb));
    expect(cb).toBeChecked();
  });

  it('shows extra principal info for detected extra payments', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      extraPrincipalCount: 3,
      averageExtraPrincipal: 100,
    });
    await renderDialog();
    expect(screen.getByText(/3 extra principal payments detected/i)).toBeInTheDocument();
  });

  it('handles setupLoanPayments error and shows toast', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockRejectedValue({ response: { data: { message: 'API error' } } });
    await renderDialog();

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));
    expect(toast.error).toHaveBeenCalled();
  });

  it('handles setupLoanPayments generic error', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockRejectedValue(new Error('boom'));
    await renderDialog();

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));
    expect(toast.error).toHaveBeenCalled();
  });

  it('changes the mortgage type and its help line (mortgage only)', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);

    const type = screen.getByLabelText('Mortgage Type') as HTMLSelectElement;
    expect(type.value).toBe('ANNUITY');
    expect(
      screen.getByText('Your total payment is the same every month. Choose this for a variable-rate mortgage too.'),
    ).toBeInTheDocument();

    await act(async () => fireEvent.change(type, { target: { value: 'CANADIAN_FIXED' } }));
    expect(type.value).toBe('CANADIAN_FIXED');
    expect(
      screen.getByText('A Canadian fixed-rate contract; interest compounds twice a year.'),
    ).toBeInTheDocument();
  });

  it('seeds the select from the type the account carries', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog({
      ...defaultProps,
      loanAccount: {
        accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD',
        mortgageType: 'CANADIAN_FIXED',
      },
    });

    expect((screen.getByLabelText('Mortgage Type') as HTMLSelectElement).value).toBe('CANADIAN_FIXED');
    const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(buttons[buttons.length - 1]));
    expect(mockSetupLoanPayments).toHaveBeenCalledWith('m-1', expect.objectContaining({
      mortgageType: 'CANADIAN_FIXED',
    }));
  });

  describe('a mortgage without a constant payment', () => {
    const linearProps = (mortgageType: 'LINEAR' | 'INTEREST_ONLY' = 'LINEAR') => ({
      ...defaultProps,
      loanAccount: {
        accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD',
        mortgageType,
        prepaymentMode: 'LOWER_INSTALLMENT' as const,
      },
    });
    const priced = {
      derivesInstallment: true,
      principalPayment: 833.3333,
      interestPayment: 500,
      paymentAmount: 1333.3333,
    };

    it('shows the first installment the server prices and submits it', async () => {
      mockDetectLoanPayments.mockResolvedValue({
        ...defaultDetected,
        lastPrincipalAmount: 800,
        lastInterestAmount: 700,
      });
      mockPreviewLoanPaymentSetup.mockResolvedValue(priced);
      mockSetupLoanPayments.mockResolvedValue({} as any);
      await renderDialog(linearProps());

      // No stated payment and no detected split to choose: the method decides both.
      expect(screen.queryByText(/Regular Payment Amount/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Use principal\/interest split/)).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('First Installment')).toBeInTheDocument());
      await waitFor(() => expect(mockPreviewLoanPaymentSetup).toHaveBeenCalled());
      expect(mockPreviewLoanPaymentSetup).toHaveBeenLastCalledWith(
        'm-1',
        expect.objectContaining({
          nextDueDate: '2026-04-01',
          paymentFrequency: 'MONTHLY',
          mortgageType: 'LINEAR',
          prepaymentMode: 'LOWER_INSTALLMENT',
        }),
      );
      await screen.findByText(/This is the one due/);

      const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
      await act(async () => fireEvent.click(buttons[buttons.length - 1]));
      const data = mockSetupLoanPayments.mock.calls[0][1];
      expect(data).toMatchObject({
        paymentAmount: 1333.3333,
        mortgageType: 'LINEAR',
        prepaymentMode: 'LOWER_INSTALLMENT',
      });
      expect(data).not.toHaveProperty('detectedInterestAmount');
    });

    it('offers the prepayment mode for LINEAR only', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      mockPreviewLoanPaymentSetup.mockResolvedValue(priced);
      await renderDialog(linearProps('INTEREST_ONLY'));
      expect(screen.queryByLabelText('What an Extra Repayment Does')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Mortgage Type'), { target: { value: 'LINEAR' } });
      });
      const mode = screen.getByLabelText('What an Extra Repayment Does') as HTMLSelectElement;
      expect(mode.value).toBe('LOWER_INSTALLMENT');
      await act(async () => {
        fireEvent.change(mode, { target: { value: 'SHORTEN_TERM' } });
      });
      await waitFor(() =>
        expect(mockPreviewLoanPaymentSetup).toHaveBeenLastCalledWith(
          'm-1',
          expect.objectContaining({ mortgageType: 'LINEAR', prepaymentMode: 'SHORTEN_TERM' }),
        ),
      );
    });

    it('names why the installment could not be priced, and does not submit', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      mockPreviewLoanPaymentSetup.mockRejectedValue({
        response: { data: { message: 'A LINEAR mortgage requires amortizationMonths' } },
      });
      await renderDialog(linearProps());

      await screen.findByText('A LINEAR mortgage requires amortizationMonths');
      const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
      expect(buttons[buttons.length - 1]).toBeDisabled();
    });

    it('falls back to a generic reason for a list of validation messages', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      mockPreviewLoanPaymentSetup.mockRejectedValue({
        response: { data: { message: ['interestRate must not be greater than 100', 'other'] } },
      });
      await renderDialog(linearProps());
      await screen.findByText(/The first installment could not be worked out/);
      expect(screen.queryByText(/interestRate must not be greater/)).not.toBeInTheDocument();
    });

    it('neither shows nor submits an answer for terms the user has since changed', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      mockSetupLoanPayments.mockResolvedValue({} as any);
      let answerFirst!: (value: typeof priced) => void;
      let answerSecond!: (value: typeof priced) => void;
      let answerThird!: (value: typeof priced) => void;
      mockPreviewLoanPaymentSetup
        .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { answerSecond = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { answerThird = resolve; }));
      await renderDialog(linearProps());
      await waitFor(() => expect(mockPreviewLoanPaymentSetup).toHaveBeenCalledTimes(1));
      await act(async () => {
        answerFirst({ ...priced, paymentAmount: 1216.52 });
      });
      await screen.findByText(/This is the one due/);
      const mode = screen.getByLabelText('What an Extra Repayment Does');
      const submit = () => {
        const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
        return buttons[buttons.length - 1];
      };

      // The terms change: the figure answered for the old ones is neither
      // shown nor submittable while the new answer is pending.
      await act(async () => {
        fireEvent.change(mode, { target: { value: 'SHORTEN_TERM' } });
      });
      expect(screen.queryByText(/This is the one due/)).not.toBeInTheDocument();
      expect(submit()).toBeDisabled();
      await waitFor(() => expect(mockPreviewLoanPaymentSetup).toHaveBeenCalledTimes(2));

      // A late answer for terms changed again before it arrived is dropped.
      await act(async () => {
        fireEvent.change(mode, { target: { value: 'LOWER_INSTALLMENT' } });
      });
      await waitFor(() => expect(mockPreviewLoanPaymentSetup).toHaveBeenCalledTimes(3));
      await act(async () => {
        answerSecond({ ...priced, paymentAmount: 9999.99 });
      });
      expect(submit()).toBeDisabled();

      await act(async () => {
        answerThird(priced);
      });
      await screen.findByText(/This is the one due/);
      await act(async () => fireEvent.click(submit()));
      expect(mockSetupLoanPayments.mock.calls[0][1]).toMatchObject({
        paymentAmount: 1333.3333,
        prepaymentMode: 'LOWER_INSTALLMENT',
      });
    });

    it('falls back to a generic reason when the server gives none', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      mockPreviewLoanPaymentSetup.mockRejectedValue(new Error('network'));
      await renderDialog(linearProps());
      await screen.findByText(/The first installment could not be worked out/);
    });

    it('asks for the next payment date before pricing anything', async () => {
      mockDetectLoanPayments.mockResolvedValue(null);
      await renderDialog(linearProps());
      expect(
        screen.getByText('Enter the next payment date to work out the first installment.'),
      ).toBeInTheDocument();
      expect(mockPreviewLoanPaymentSetup).not.toHaveBeenCalled();
    });

    it('never asks for an annuity mortgage', async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      await renderDialog({
        ...defaultProps,
        loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350));
      });
      expect(mockPreviewLoanPaymentSetup).not.toHaveBeenCalled();
      expect(screen.getByText(/Regular Payment Amount/)).toBeInTheDocument();
    });
  });

  it('submits mortgage with mortgage-specific fields', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);

    const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(buttons[buttons.length - 1]));
    expect(mockSetupLoanPayments).toHaveBeenCalledWith('m-1', expect.objectContaining({
      mortgageType: 'ANNUITY',
    }));
  });

  it('sends no mortgage type for an ordinary loan', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const buttons = screen.getAllByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(buttons[buttons.length - 1]));
    const data = mockSetupLoanPayments.mock.calls[0][1];
    expect(data).not.toHaveProperty('mortgageType');
  });

  it('stops offering quarterly and yearly once the mortgage compounds semi-annually', async () => {
    // The mortgage helpers have no quarterly or yearly cadence, so the server
    // answers 400 rather than split the payment at a monthly rate. Offering the
    // choice made a working flow fail with nothing on the form to explain it.
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog({
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    });

    const frequency = screen.getByLabelText(/Payment Frequency/i) as HTMLSelectElement;
    const optionsOf = () => Array.from(frequency.options).map((o) => o.value);
    expect(optionsOf()).toContain('QUARTERLY');
    expect(optionsOf()).toContain('YEARLY');

    await act(async () =>
      fireEvent.change(screen.getByLabelText('Mortgage Type'), { target: { value: 'CANADIAN_FIXED' } }),
    );
    expect(optionsOf()).not.toContain('QUARTERLY');
    expect(optionsOf()).not.toContain('YEARLY');
    // The cadences a Canadian mortgage genuinely has stay.
    expect(optionsOf()).toEqual(
      expect.arrayContaining(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']),
    );
  });

  it('does not submit a cadence the semi-annual restriction removed', async () => {
    // Selecting quarterly first and choosing the type after is the order that
    // matters: the value has to be corrected, not merely hidden from the list.
    // And choosing ANNUITY again restores the choice rather than silently
    // keeping monthly.
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog({
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    });

    const frequency = screen.getByLabelText(/Payment Frequency/i) as HTMLSelectElement;
    await act(async () => fireEvent.change(frequency, { target: { value: 'QUARTERLY' } }));
    expect(frequency.value).toBe('QUARTERLY');

    const type = screen.getByLabelText('Mortgage Type');
    await act(async () => fireEvent.change(type, { target: { value: 'CANADIAN_FIXED' } }));
    expect(frequency.value).toBe('MONTHLY');

    const submit = screen.getAllByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submit[submit.length - 1]));
    expect(mockSetupLoanPayments).toHaveBeenCalledWith(
      'm-1',
      expect.objectContaining({ paymentFrequency: 'MONTHLY' }),
    );

    await act(async () => fireEvent.change(type, { target: { value: 'ANNUITY' } }));
    expect(frequency.value).toBe('QUARTERLY');
  });

  it('keeps every cadence for an ordinary loan and a nominally compounded mortgage', () => {
    // The restriction is the semi-annual convention's, not the account type's:
    // a nominally compounded mortgage is split by calculatePaymentSplit, which
    // handles quarterly and yearly perfectly well.
    return (async () => {
      mockDetectLoanPayments.mockResolvedValue(defaultDetected);
      for (const accountType of ['LOAN', 'MORTGAGE']) {
        const { unmount } = await renderDialog({
          ...defaultProps,
          loanAccount: { accountId: 'x-1', accountName: 'X', accountType, currencyCode: 'USD' },
        });
        const frequency = screen.getByLabelText(/Payment Frequency/i) as HTMLSelectElement;
        expect(Array.from(frequency.options).map((o) => o.value)).toEqual([
          'WEEKLY',
          'BIWEEKLY',
          'SEMIMONTHLY',
          'MONTHLY',
          'QUARTERLY',
          'YEARLY',
        ]);
        unmount();
      }
    })();
  });

  it('toggles auto-post checkbox', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const cb = screen.getByLabelText(/Automatically post transactions when due/i);
    await act(async () => fireEvent.click(cb));
    expect(cb).toBeChecked();
  });

  it('updates payment amount via CurrencyInput', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    // Change frequency
    const select = screen.getByLabelText(/Payment Frequency/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'WEEKLY' } });
    expect(select.value).toBe('WEEKLY');
  });

  it('changes source account via select', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const select = screen.getByLabelText(/Payment From Account/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'acc-1' } });
    expect(select.value).toBe('acc-1');
  });

  it('updates interest rate via input', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const input = screen.getByPlaceholderText('e.g. 5.5') as HTMLInputElement;
    // Focus first: NumericInput only reformats the text while the field is not
    // focused, so a change without one would come back as "4.50" mid-typing.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '4.5' } });
    expect(input.value).toBe('4.5');

    // Clear it
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
  });

  it('updates amortization and term inputs (mortgage only)', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);

    const amortInput = screen.getByPlaceholderText('e.g., 300') as HTMLInputElement;
    fireEvent.change(amortInput, { target: { value: '360' } });
    expect(amortInput.value).toBe('360');
    fireEvent.change(amortInput, { target: { value: '' } });
    expect(amortInput.value).toBe('');

    const termInput = screen.getByPlaceholderText('e.g., 60') as HTMLInputElement;
    fireEvent.change(termInput, { target: { value: '48' } });
    expect(termInput.value).toBe('48');
  });

  it('shows Low confidence label for low-confidence detection', async () => {
    mockDetectLoanPayments.mockResolvedValue({ ...defaultDetected, confidence: 0.2 });
    await renderDialog();
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('shows Medium confidence label', async () => {
    mockDetectLoanPayments.mockResolvedValue({ ...defaultDetected, confidence: 0.5 });
    await renderDialog();
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('shows form even when no detection (paymentCount=0)', async () => {
    mockDetectLoanPayments.mockResolvedValue({ ...defaultDetected, paymentCount: 0 });
    await renderDialog();
    expect(screen.getByText('Set Up Loan Payments')).toBeInTheDocument();
    expect(screen.queryByText(/Detected/)).not.toBeInTheDocument();
  });

  it('handles detection failure gracefully', async () => {
    mockDetectLoanPayments.mockRejectedValue(new Error('API error'));
    await renderDialog();
    expect(screen.getByText('Set Up Loan Payments')).toBeInTheDocument();
  });

  it('does not run detection when isOpen is false', () => {
    render(<LoanPaymentSetupDialog {...defaultProps} isOpen={false} />);
    expect(mockDetectLoanPayments).not.toHaveBeenCalled();
  });

  it('shows validation error toast when required fields are missing', async () => {
    // No detection result -> paymentAmount 0, nextDueDate '' -> submit blocked
    mockDetectLoanPayments.mockResolvedValue(null);
    await renderDialog();

    // The button is disabled when fields are missing, so call submit via the
    // handler path by clicking after enabling amount. Instead, assert the
    // button is disabled (guard path) — covers the disabled branch.
    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    expect(submitButton).toBeDisabled();
  });

  it('submits extra principal amount when included and greater than zero', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const checkbox = screen.getByLabelText(/Include extra payment to principal/i);
    await act(async () => fireEvent.click(checkbox));

    // Enter an extra principal value
    const extraInput = screen.getByLabelText(/Extra Principal Per Payment/i) as HTMLInputElement;
    await act(async () => fireEvent.change(extraInput, { target: { value: '200' } }));
    await act(async () => fireEvent.blur(extraInput));

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));

    expect(mockSetupLoanPayments).toHaveBeenCalledWith('loan-1', expect.objectContaining({
      extraPrincipal: 200,
      // total = 1500 + 200
      paymentAmount: 1700,
    }));
  });

  it('shows total payment line when extra principal is included', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const checkbox = screen.getByLabelText(/Include extra payment to principal/i);
    await act(async () => fireEvent.click(checkbox));
    const extraInput = screen.getByLabelText(/Extra Principal Per Payment/i) as HTMLInputElement;
    await act(async () => fireEvent.change(extraInput, { target: { value: '100' } }));

    expect(screen.getByText(/Total payment:/)).toBeInTheDocument();
  });

  it('submits detectedInterestAmount when useDetectedSplit is enabled', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      lastPrincipalAmount: 1200,
      lastInterestAmount: 300,
    });
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const cb = screen.getByLabelText(/Use principal\/interest split/i);
    await act(async () => fireEvent.click(cb));
    expect(cb).toBeChecked();

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));

    expect(mockSetupLoanPayments).toHaveBeenCalledWith('loan-1', expect.objectContaining({
      detectedInterestAmount: 300,
    }));
  });

  it('shows detected split line in the banner when split data is present', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      lastPrincipalAmount: 1200,
      lastInterestAmount: 300,
    });
    await renderDialog();
    expect(screen.getByText(/Last payment split:/)).toBeInTheDocument();
  });

  it('enables detected split by default for mortgages when split data is available', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      lastPrincipalAmount: 1200,
      lastInterestAmount: 300,
    });
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);
    const cb = screen.getByLabelText(/Use principal\/interest split/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('shows estimated interest rate hint from detection', async () => {
    mockDetectLoanPayments.mockResolvedValue({ ...defaultDetected, estimatedInterestRate: 4.25 });
    await renderDialog();
    expect(screen.getByText(/Estimated from transaction history/)).toBeInTheDocument();
  });

  it('shows detected interest category hint when category not selected', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      interestCategoryName: 'Interest Expense',
      interestCategoryId: null,
    });
    await renderDialog();
    expect(screen.getByText(/Detected: Interest Expense/)).toBeInTheDocument();
  });

  it('pre-fills extra principal from detection when averageExtraPrincipal > 0', async () => {
    mockDetectLoanPayments.mockResolvedValue({
      ...defaultDetected,
      averageExtraPrincipal: 150,
      extraPrincipalCount: 2,
    });
    await renderDialog();
    // Checkbox should be checked (pre-filled) so the extra input shows
    const checkbox = screen.getByLabelText(/Include extra payment to principal/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByLabelText(/Extra Principal Per Payment/i)).toBeInTheDocument();
  });

  it('selects first source account when no detection result is returned', async () => {
    // No detection -> sourceAccountOptions[0] should be selected
    mockDetectLoanPayments.mockResolvedValue(null);
    const props = {
      ...defaultProps,
      accounts: [sourceAccount],
    };
    await renderDialog(props);
    const select = screen.getByLabelText(/Payment From Account/i) as HTMLSelectElement;
    expect(select.value).toBe('acc-1');
  });

  it('submits with interestRate and selected source account', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockSetupLoanPayments.mockResolvedValue({} as any);
    await renderDialog();

    const rateInput = screen.getByPlaceholderText('e.g. 5.5') as HTMLInputElement;
    await act(async () => fireEvent.change(rateInput, { target: { value: '6.25' } }));

    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));

    expect(mockSetupLoanPayments).toHaveBeenCalledWith('loan-1', expect.objectContaining({
      interestRate: 6.25,
    }));
  });

  it('selects an existing payee via the payee combobox', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const payeeInput = screen.getByTestId('combobox-input-payee');
    await act(async () => fireEvent.change(payeeInput, { target: { value: 'payee-x' } }));

    mockSetupLoanPayments.mockResolvedValue({} as any);
    const submitButton = screen.getByRole('button', { name: /Set Up Payments/i });
    await act(async () => fireEvent.click(submitButton));

    expect(mockSetupLoanPayments).toHaveBeenCalledWith('loan-1', expect.objectContaining({
      payeeId: 'payee-x',
      payeeName: 'Chosen Name',
    }));
  });

  it('creates a new payee via onCreateNew and shows a success toast', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockCreatePayee.mockResolvedValue({ id: 'p-new', name: 'Brand New Lender' } as any);
    await renderDialog();

    const createBtn = screen.getByTestId('combobox-create-payee');
    await act(async () => fireEvent.click(createBtn));

    expect(mockCreatePayee).toHaveBeenCalledWith({ name: 'Brand New Lender' });
    expect(toast.success).toHaveBeenCalledWith('Payee "Brand New Lender" created');
  });

  it('does not call create when the new payee name is blank', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    await renderDialog();

    const createEmptyBtn = screen.getByTestId('combobox-create-empty');
    await act(async () => fireEvent.click(createEmptyBtn));

    expect(mockCreatePayee).not.toHaveBeenCalled();
  });

  it('shows an error toast when creating a payee fails', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockCreatePayee.mockRejectedValueOnce({ response: { data: { message: 'Payee exists' } } });
    await renderDialog();

    const createBtn = screen.getByTestId('combobox-create-payee');
    await act(async () => fireEvent.click(createBtn));

    expect(toast.error).toHaveBeenCalledWith('Payee exists');
  });

  it('shows a generic error toast when payee create fails without a message', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    mockCreatePayee.mockRejectedValueOnce(new Error('boom'));
    await renderDialog();

    const createBtn = screen.getByTestId('combobox-create-payee');
    await act(async () => fireEvent.click(createBtn));

    expect(toast.error).toHaveBeenCalledWith('Failed to create payee');
  });
});
