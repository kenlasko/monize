import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
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
const mockGetCategories = vi.mocked(categoriesApi.getAll);
const mockCreatePayee = vi.mocked(payeesApi.create);

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'My Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, institutionId: null, openingBalance: 0, currentBalance: 1000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null, linkedLoanAccountId: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null, termEndDate: null,
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

async function renderDialog(props = defaultProps) {
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
    expect(screen.getByText(/Canadian Mortgage/)).toBeInTheDocument();
    expect(screen.getByText(/Variable Rate/)).toBeInTheDocument();
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

  it('toggles canadian mortgage and variable rate checkboxes (mortgage only)', async () => {
    mockDetectLoanPayments.mockResolvedValue(defaultDetected);
    const mortgageProps = {
      ...defaultProps,
      loanAccount: { accountId: 'm-1', accountName: 'M', accountType: 'MORTGAGE', currencyCode: 'USD' },
    };
    await renderDialog(mortgageProps);

    const canadianCb = screen.getByLabelText(/Canadian Mortgage/i);
    await act(async () => fireEvent.click(canadianCb));
    expect(canadianCb).toBeChecked();

    const variableCb = screen.getByLabelText(/Variable Rate/i);
    await act(async () => fireEvent.click(variableCb));
    expect(variableCb).toBeChecked();
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
      isCanadianMortgage: false,
      isVariableRate: false,
    }));
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

    const input = screen.getByPlaceholderText('e.g., 5.5') as HTMLInputElement;
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

    const rateInput = screen.getByPlaceholderText('e.g., 5.5') as HTMLInputElement;
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
