import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { LoanAmortizationReport } from './LoanAmortizationReport';

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: 'CAD',
    }),
  };
});
const mockGetAllAccounts = vi.fn();
const mockGetAllTransactions = vi.fn();
const mockGetAllPages = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

const mockGetRateChanges = vi.fn();
// Only the API is mocked; supportsRateChanges is the predicate under test here,
// so it stays real rather than being restated in the mock.
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: {
    getAll: (...args: any[]) => mockGetRateChanges(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
    getAllPages: (...args: any[]) => mockGetAllPages(...args),
  },
}));

const mockGetLoanProjectionAnchor = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getLoanProjectionAnchor: (...args: any[]) =>
      mockGetLoanProjectionAnchor(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * Render the report and let its two loaders settle inside `act`.
 *
 * The report fetches on mount -- the accounts list and, keyed off the resulting
 * selection, that loan's transactions, booked interest and rate history -- so a
 * bare `render(...)` leaves those updates landing outside `act` and the
 * assertions run against a tree React has not finished. `docs/frontend/testing.md`:
 * give the file one helper and use it everywhere.
 */
async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<LoanAmortizationReport />);
  });
  // A second flush, because the two loaders are SEQUENTIAL: the accounts fetch
  // settles inside the first, which seeds the selection, and only then does the
  // history fetch start -- so its resolution lands in a later microtask. One
  // flush leaves those updates outside `act`.
  await act(async () => {});
  return result!;
}

describe('LoanAmortizationReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Most cases have no recorded rate history; the ones that do override it.
    mockGetRateChanges.mockResolvedValue([]);
    // Most cases have no scheduled payment, so the projection keeps its
    // today-anchored fallback; the anchored cases override this.
    mockGetLoanProjectionAnchor.mockResolvedValue({
      nextDueDate: null,
      debt: null,
    });
  });

  it('shows loading state initially', async () => {
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    // The report has a SECOND loader beside the account list -- this loan's
    // transactions, interest and rate history -- and with no account selected
    // yet it resolves immediately with empty lists. That resolution is a state
    // update, so a synchronous `render` leaves it to land after the test body,
    // which is the act() warning the guard fails on (`src/test/act-guard.ts`).
    // Wrapping the render is the file's own convention for a component that
    // fetches on mount; the assertion is unchanged, because the account list
    // never resolves and the report therefore cannot leave its loading state.
    await renderReport();
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no loan accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No loan or mortgage accounts found/)).toBeInTheDocument();
    });
  });

  it('fetches the loan\'s separately-booked interest expenses (issue #893)', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -100000,
        openingBalance: -120000,
        interestRate: 5.0,
        paymentAmount: 800,
        paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int',
        sourceAccountId: 'src-1',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockResolvedValue([
      { id: 'i1', transactionDate: '2024-06-01', amount: -300, categoryId: 'cat-int', isTransfer: false },
    ]);

    await renderReport();

    // The report pulls the loan's interest expenses, scoped to its configured
    // interest category + source account, so its interest matches the loan
    // detail page.
    await waitFor(() =>
      expect(mockGetAllPages).toHaveBeenCalledWith({
        categoryIds: ['cat-int'],
        accountIds: ['src-1'],
      }),
    );
  });

  it('renders account selector and summary with data', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-01', amount: 350, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('renders payment history table header', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Student Loan',
        accountType: 'LOAN',
        currentBalance: -5000,
        openingBalance: -15000,
        interestRate: 3.5,
        paymentAmount: 200,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-03-01', amount: 180, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-04-01', amount: 180, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    });
  });

  it('selects first account by default when multiple accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        mortgageType: 'CANADIAN_FIXED', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    // Both accounts should appear as options
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
  });

  it('filters out non-loan account types', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'chequing-1', name: 'Chequing', accountType: 'CHEQUING',
        currentBalance: 5000, openingBalance: 5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -15000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.queryByText('Chequing')).not.toBeInTheDocument();
  });

  it('shows "No payments found" when account has no transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'New Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No payments found for this loan/)).toBeInTheDocument();
    });
  });

  it('displays summary cards with correct values', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -8000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 350, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 350, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
    expect(screen.getByText('Original Amount')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('shows "Not set" when interest rate is null', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'Line of Credit', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      // Multiple "Not set" texts (interestRate, paymentFrequency, paymentAmount are all null)
      const notSetElements = screen.getAllByText('Not set');
      expect(notSetElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows 0% -- not "Not set" -- for an interest-free loan', async () => {
    // The resolved rate is `number | null` precisely so absence travels; reading
    // it for truthiness throws that away again and reports a recorded 0% as
    // unconfigured. 0 is a rate.
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-0', name: 'Interest-free loan', accountType: 'LOAN',
        currentBalance: -900, openingBalance: -1200, interestRate: 0,
        paymentAmount: 150, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2026-01-15', amount: 150, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2026-02-15', amount: 150, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('0%')).toBeInTheDocument();
    });
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
  });

  it('displays account details section with correct type labels', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'My Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 4.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Account Type')).toBeInTheDocument();
    });
    expect(screen.getByText('Loan')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows "Closed" status for closed accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Old Loan', accountType: 'LOAN',
        currentBalance: 0, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: true,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });
  });

  it('renders payment table with correct columns', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('#')).toBeInTheDocument();
    });
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByText('Interest')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
  });

  it('renders payment table with interest from linked transaction splits', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1', transactionDate: '2024-01-15', amount: 450,
          linkedTransaction: {
            id: 'parent-1',
            splits: [
              { amount: -450, transferAccountId: 'loan-1' },
              { amount: -50, transferAccountId: 'interest-expense' },
            ],
          },
        },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      // Check payment history header shows correct count after transactions load
      expect(screen.getByText(/1 payments made/)).toBeInTheDocument();
    });
  });

  it('shows "Payment History & Projection" header when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment History & Projection')).toBeInTheDocument();
    });
  });

  it('shows "Payment History" header when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment History')).toBeInTheDocument();
    });
  });

  it('shows "Projected Future Payments" separator row', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    });
  });

  describe('anchored projection (issue #1253)', () => {
    // Whether the anchor is USED is decided by its position relative to TODAY
    // -- an overdue one is refused -- so the clock is pinned rather than read.
    // Without this the case passes until 2026-08-15 drifts into the past and
    // then fails with nothing changed. Only `Date` is faked: RTL's `waitFor`
    // cannot drive Vitest's fake timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('prices the first projected row from the anchored ledger debt, matching the next bill (issue #1253)', async () => {
      // Today's balance is -200,000, but a 1,500 principal-only payment already
      // posted for a date before the next installment: the scheduled bill prices
      // 198,500 * 0.005 = 992.50 of interest, and the report's first projected
      // row must show the same figure -- not 1,000.00 from the stale balance.
      mockGetAllAccounts.mockResolvedValue([
        {
          id: 'loan-1', name: 'Mortgage', accountType: 'LOAN',
          currentBalance: -200000, openingBalance: -210000, interestRate: 6,
          paymentAmount: 1500, paymentFrequency: 'MONTHLY',
          mortgageType: 'ANNUITY', isClosed: false,
        },
      ]);
      mockGetAllTransactions.mockResolvedValue({
        data: [
          { id: 'tx-1', transactionDate: '2026-07-15', amount: 1500, linkedTransaction: null },
        ],
        pagination: { hasMore: false },
      });
      mockGetLoanProjectionAnchor.mockResolvedValue({
        nextDueDate: '2026-08-15',
        debt: 198500,
      });

      await renderReport();

      await waitFor(() => {
        expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
      });
      expect(mockGetLoanProjectionAnchor).toHaveBeenCalledWith('loan-1');
      // First projected row: the bill's own interest for the installment.
      expect(screen.getAllByText('$992.50').length).toBeGreaterThan(0);
      expect(screen.queryByText('$1000.00')).not.toBeInTheDocument();
    });
  });

  describe('a mortgage without a constant payment', () => {
    // docs/specs/mortgage-types.md section 5.6: `payment_amount` is null for
    // these methods, and the report shows the next installment with its date
    // (and an interest-only bullet) rather than a constant "Payment Amount".
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
      mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      mockGetLoanProjectionAnchor.mockResolvedValue({
        nextDueDate: '2026-08-15',
        debt: 265000.0006,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const mortgage = (mortgageType: 'LINEAR' | 'INTEREST_ONLY') => ({
      id: 'loan-1', name: 'Hypotheek', accountType: 'MORTGAGE',
      currentBalance: -265000.0006, openingBalance: -300000, interestRate: 2,
      paymentAmount: null, paymentFrequency: 'MONTHLY', paymentStartDate: '2025-02-15',
      amortizationMonths: 360, originalPrincipal: 300000,
      mortgageType, prepaymentMode: null,
      isClosed: false,
    });

    it('shows a LINEAR mortgage\'s next installment with its date', async () => {
      mockGetAllAccounts.mockResolvedValue([mortgage('LINEAR')]);
      await renderReport();
      await waitFor(() => {
        expect(screen.getByText('Next Installment')).toBeInTheDocument();
      });
      expect(screen.queryByText('Payment Amount')).not.toBeInTheDocument();
      expect(screen.getByText(/^\$1275\.00, due .*2026/)).toBeInTheDocument();
      expect(screen.queryByText('Final Payment')).not.toBeInTheDocument();
    });

    it('shows an INTEREST_ONLY mortgage\'s bullet beside its installment', async () => {
      mockGetAllAccounts.mockResolvedValue([mortgage('INTEREST_ONLY')]);
      await renderReport();
      await waitFor(() => {
        expect(screen.getByText('Final Payment')).toBeInTheDocument();
      });
      expect(screen.getByText(/^\$441\.67, due .*2026/)).toBeInTheDocument();
      expect(screen.getByText(/^\$265441\.67, due .*2055/)).toBeInTheDocument();
    });
  });

  it('shows Est. Payoff card when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('shows "Est. Total Interest" label when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Est. Total Interest')).toBeInTheDocument();
    });
  });

  it('shows "Total Interest Paid" label when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Total Interest Paid')).toBeInTheDocument();
    });
  });

  it('displays Mortgage account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        mortgageType: 'CANADIAN_FIXED', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 1000, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Mortgage')).toBeInTheDocument();
    });
  });

  it('displays Line of Credit account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: 8.0,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Line of Credit')).toBeInTheDocument();
    });
  });

  it('shows a retryable error when loading accounts fails', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
  });

  it('shows a retryable error when loading the loan transactions fails', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
    // The schedule must not be drawn from a history that failed to load: an
    // empty one projects a plausible payoff from no payments at all.
    expect(screen.queryByText(/payments made/)).not.toBeInTheDocument();
    // But the picker stays: the selection is persisted, so replacing the whole
    // report would restore this loan's error on every visit with no way to
    // choose another account.
    expect(screen.getByText('Select Loan')).toBeInTheDocument();
  });

  it('shows a retryable error when the interest lookup fails, not a zero-interest schedule', async () => {
    // The loan books interest as separate expenses. The payments load, the
    // interest lookup does not -- and an empty interest list is exactly what
    // tells the derivation that these payments carried no interest. Rendering
    // Interest $0.00 here is a plausible, wrong figure the user cannot tell from
    // a real one (audit of PR #1258).
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE',
        currentBalance: -100000, openingBalance: -120000, interestRate: 5.0,
        paymentAmount: 800, paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int', sourceAccountId: 'src-1',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockRejectedValue(new Error('timeout'));

    await renderReport();

    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
    expect(screen.queryByText(/payments made/)).not.toBeInTheDocument();
  });

  it('recovers the schedule when the retry succeeds', async () => {
    // The whole point of surfacing the failure is that the user can ask again,
    // so Try again has to re-issue both fetches -- a retry that only re-renders
    // is the swallowed error with an extra button.
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE',
        currentBalance: -100000, openingBalance: -120000, interestRate: 5.0,
        paymentAmount: 800, paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int', sourceAccountId: 'src-1',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue([
      { id: 'i1', transactionDate: '2024-06-01', amount: -300, categoryId: 'cat-int', isTransfer: false },
    ]);

    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Try again'));
    });

    await waitFor(() => {
      expect(screen.getByText(/1 payments made/)).toBeInTheDocument();
    });
    // The booked $300 is on screen because the retry actually re-fetched it,
    // not because the report settled for an empty interest list.
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  // The report used to pass [] as the rate history, so its projection ran at
  // whatever stale scalar the account still held while the loan detail page ran
  // at the real timeline rate -- the same loan, two payoff dates. These two
  // cases differ ONLY in the recorded rate history.
  const divergentRateAccount = [
    {
      id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE',
      currentBalance: -100000, openingBalance: -100000, interestRate: 5,
      paymentAmount: 500, paymentFrequency: 'MONTHLY',
      mortgageType: 'ANNUITY', isClosed: false,
    },
  ];
  const onePayment = {
    data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null }],
    pagination: { hasMore: false },
  };

  it('loads the loan rate history for the selected account', async () => {
    mockGetAllAccounts.mockResolvedValue(divergentRateAccount);
    mockGetAllTransactions.mockResolvedValue(onePayment);
    await renderReport();
    await waitFor(() => expect(mockGetRateChanges).toHaveBeenCalledWith('loan-1'));
  });

  it('projects at the scalar rate when no rate change has been recorded', async () => {
    // 100000 at 5% costs 416.67 a month, so the 500 payment amortizes.
    mockGetAllAccounts.mockResolvedValue(divergentRateAccount);
    mockGetAllTransactions.mockResolvedValue(onePayment);
    mockGetRateChanges.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    });
  });

  it('withholds the projection when the recorded rate makes the payment non-amortizing', async () => {
    // Same fixture, but a recorded rate change to 12%: 100000 now costs 1000 a
    // month and the 500 payment does not amortize, so there is no payoff to
    // show. Reading the stale 5% scalar instead would print a plausible one.
    mockGetAllAccounts.mockResolvedValue(divergentRateAccount);
    mockGetAllTransactions.mockResolvedValue(onePayment);
    mockGetRateChanges.mockResolvedValue([
      { id: 'r1', effectiveDate: '2024-02-01', annualRate: 12, newPaymentAmount: null },
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.queryByText('Projected Future Payments')).not.toBeInTheDocument();
  });

  it('does not ask for a line of credit\'s rate history, which the API rejects', async () => {
    // /accounts/:id/rate-changes answers 400 for a LINE_OF_CREDIT
    // (LoanRateChangesService.verifyLoanAccount), and this report lists LOCs. A
    // rejection here lands in the shared error state and replaces the whole
    // report -- selector included -- and because the selection is persisted it
    // stays broken across reloads. The mocks resolving [] for every account type
    // is why this went unnoticed: a fixture the API cannot produce.
    mockGetRateChanges.mockRejectedValue(new Error('400 not a loan account'));
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: 8,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null }],
      pagination: { hasMore: false },
    });

    await renderReport();

    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(mockGetRateChanges).not.toHaveBeenCalled();
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });

  it('exports CSV and PDF', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToCsv as any).mockClear();
    (exportToPdf as any).mockClear();
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'My Car Loan!', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
        currencyCode: 'CAD',
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      await act(async () => {
        fireEvent.click(csvBtn);
      });
    }
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
    expect(exportToCsv).toHaveBeenCalled();
  });

  it('toggles show all rows when there are more than 24 payments', async () => {
    const txs = Array.from({ length: 30 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
      amount: 100,
      linkedTransaction: null,
    }));
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -1000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: txs, pagination: { hasMore: false } });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Show all/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Show all/));
    });
    expect(screen.getByText(/Show fewer rows/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText(/Show fewer rows/));
    });
  });

  it('handles WEEKLY, BIWEEKLY, SEMI_MONTHLY, QUARTERLY, YEARLY frequencies', async () => {
    const freqs = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'QUARTERLY', 'YEARLY', 'ACCELERATED_BIWEEKLY', 'ACCELERATED_WEEKLY'];
    for (const freq of freqs) {
      vi.clearAllMocks();
      mockGetAllAccounts.mockResolvedValue([
        {
          id: 'loan-1', name: 'Loan', accountType: 'LOAN',
          currentBalance: -2000, openingBalance: -5000, interestRate: 5.0,
          paymentAmount: 100, paymentFrequency: freq,
          mortgageType: 'ANNUITY', isClosed: false,
        },
      ]);
      mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      const { unmount } = await renderReport();
      await waitFor(() => {
        expect(screen.getByText('Select Loan')).toBeInTheDocument();
      });
      unmount();
    }
  });

  it('does not project when payment cannot cover interest', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -100000, openingBalance: -100000, interestRate: 50,
        paymentAmount: 10, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No payments found/)).toBeInTheDocument();
    });
  });

  it('paginates through transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    // First page has more, second page doesn't
    mockGetAllTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-02-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: false },
      });
    await renderReport();
    await waitFor(() => {
      expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/2 payments made/)).toBeInTheDocument();
    });
  });

  it('exercises every sortable column on the amortization table', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'acc-loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currencyCode: 'CAD',
        currentBalance: -200000,
        interestRate: 5,
        loanTerm: 360,
        loanFrequency: 'MONTHLY',
        loanStartDate: '2020-01-01',
        loanEndDate: '2050-01-01',
        loanPayment: 1500,
        mortgageType: 'ANNUITY',
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 1500, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 1500, linkedTransaction: null },
        { id: 'tx-3', transactionDate: '2024-03-15', amount: 1500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<LoanAmortizationReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('table thead th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
  });

  it('restores the persisted loan selection instead of the first loan', async () => {
    window.localStorage.setItem(
      'monize-reports-loan-amortization-account',
      JSON.stringify('loan-2'),
    );
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
      {
        id: 'loan-2',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetAllPages.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-2');
    });
  });

  it('falls back to the first loan when the persisted account is gone', async () => {
    window.localStorage.setItem(
      'monize-reports-loan-amortization-account',
      JSON.stringify('deleted-loan'),
    );
    mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetAllPages.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-1');
    });
  });
});
