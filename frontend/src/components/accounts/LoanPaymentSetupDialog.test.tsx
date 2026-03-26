import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { LoanPaymentSetupDialog } from './LoanPaymentSetupDialog';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockDetectLoanPayments = vi.mocked(accountsApi.detectLoanPayments);
const mockSetupLoanPayments = vi.mocked(accountsApi.setupLoanPayments);
const mockGetCategories = vi.mocked(categoriesApi.getAll);

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'My Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 0, currentBalance: 1000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, excludeFromNetWorth: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
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
      loanAccount: { accountId: 'loan-1', accountName: 'My Mortgage', accountType: 'MORTGAGE' },
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
});
