import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

function createBill(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    userId: 'user-1',
    accountId: 'acc-1',
    account: null,
    name: 'Internet',
    payeeId: null,
    payee: null,
    payeeName: null,
    categoryId: null,
    category: null,
    amount: -80,
    currencyCode: 'USD',
    originalAmount: null,
    originalCurrencyCode: null,
    exchangeRate: 1,
    description: null,
    referenceNumber: null,
    frequency: 'MONTHLY',
    nextDueDate: '2026-02-25',
    startDate: '2026-01-01',
    endDate: null,
    occurrencesRemaining: null,
    totalOccurrences: null,
    isActive: true,
    autoPost: true,
    reminderDaysBefore: 3,
    lastPostedDate: null,
    isSplit: false,
    isTransfer: false,
    transferAccountId: null,
    transferAccount: null,
    isInvestment: false,
    investmentAction: null,
    investmentSecurityId: null,
    investmentSecurity: null,
    investmentFundingAccountId: null,
    investmentFundingAccount: null,
    investmentQuantity: null,
    investmentPrice: null,
    investmentCommission: null,
    investmentTotalAmount: null,
    investmentExchangeRate: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('BudgetUpcomingBills', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading', () => {
    render(
      <BudgetUpcomingBills
        scheduledTransactions={[]}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Upcoming Bills')).toBeInTheDocument();
  });

  it('shows empty state when no bills', () => {
    render(
      <BudgetUpcomingBills
        scheduledTransactions={[]}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('No bills due this period.')).toBeInTheDocument();
  });

  it('displays upcoming bills within the period', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Internet', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Insurance', amount: -150, nextDueDate: '2026-02-28' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Internet')).toBeInTheDocument();
    expect(screen.getByText('Insurance')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
  });

  it('calculates total upcoming bills', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Internet', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Insurance', amount: -150, nextDueDate: '2026-02-28' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$230.00')).toBeInTheDocument();
  });

  it('calculates truly available amount', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Internet', amount: -80, nextDueDate: '2026-02-25' }),
    ];

    // truly available = 5200 - 3000 - 80 = 2120
    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$2120.00')).toBeInTheDocument();
  });

  // Discussion #1784: today is 2026-02-19, so the window opens on 2026-01-19.
  it('counts a recent overdue bill and leaves a forgotten one out', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Internet', amount: -80, nextDueDate: '2026-02-10' }),
      createBill({ id: 'st-2', name: 'Insurance', amount: -150, nextDueDate: '2026-01-18' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Internet')).toBeInTheDocument();
    expect(screen.queryByText('Insurance')).not.toBeInTheDocument();
    expect(screen.getByText('$2120.00')).toBeInTheDocument();
  });

  it('excludes inactive bills', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Active Bill', amount: -80, nextDueDate: '2026-02-25', isActive: true }),
      createBill({ id: 'st-2', name: 'Inactive Bill', amount: -150, nextDueDate: '2026-02-28', isActive: false }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Active Bill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Bill')).not.toBeInTheDocument();
  });

  it('excludes deposits (positive amounts)', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Bill', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Deposit', amount: 500, nextDueDate: '2026-02-25' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.queryByText('Deposit')).not.toBeInTheDocument();
  });

  // Issue #1124: a bill left at 0 because the amount varies month to month was
  // dropped by a `>= 0` sign test, so a payment the user still has to make was
  // invisible on the budget.
  it('shows a zero-amount reminder without adding it to the total', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Internet', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Card Payment', amount: 0, nextDueDate: '2026-02-26' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Card Payment')).toBeInTheDocument();
    // Total upcoming is the $80 bill alone -- the placeholder states no amount.
    // The row and the total both read $80.00.
    expect(screen.getAllByText('$80.00')).toHaveLength(2);
    expect(screen.getByText('$2120.00')).toBeInTheDocument();
  });

  it('does not paint a zero-amount reminder as a bill', () => {
    const bills = [
      createBill({ id: 'st-2', name: 'Card Payment', amount: 0, nextDueDate: '2026-02-26' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    const amount = screen.getAllByText('$0.00')[0];
    expect(amount.className).not.toContain('text-red-600');
    expect(amount.className).toContain('text-gray-500');
  });

  it('excludes transfers', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'Bill', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Card Transfer', amount: -300, isTransfer: true, nextDueDate: '2026-02-25' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.queryByText('Card Transfer')).not.toBeInTheDocument();
  });

  it('shows overflow indicator when more than 5 bills', () => {
    const bills = Array.from({ length: 7 }, (_, i) =>
      createBill({
        id: `st-${i}`,
        name: `Bill ${i + 1}`,
        amount: -50,
        nextDueDate: `2026-02-${String(20 + i).padStart(2, '0')}`,
      }),
    );

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={1000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('+2 more bills')).toBeInTheDocument();
  });

  it('excludes bills past the period end', () => {
    const bills = [
      createBill({ id: 'st-1', name: 'In Period', amount: -80, nextDueDate: '2026-02-25' }),
      createBill({ id: 'st-2', name: 'Next Month', amount: -150, nextDueDate: '2026-03-05' }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('In Period')).toBeInTheDocument();
    expect(screen.queryByText('Next Month')).not.toBeInTheDocument();
  });

  it('uses override amount when nextOverride exists', () => {
    const bills = [
      createBill({
        id: 'st-1',
        name: 'Modified Bill',
        amount: -80,
        nextDueDate: '2026-02-25',
        nextOverride: { amount: -50 } as any,
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    // Should show override amount (50), not default (80) - appears in item row and total
    const amounts = screen.getAllByText('$50.00');
    expect(amounts.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('$80.00')).not.toBeInTheDocument();
  });

  /**
   * The occurrence's identity is its recurrence slot, but the date it falls on is
   * the override's. Filtering, sorting and printing the slot announces a payment
   * on a day the user has already changed (issue #1247).
   */
  it('shows the date an override moved the occurrence to', () => {
    const bills = [
      createBill({
        id: 'st-1',
        name: 'Moved Bill',
        amount: -80,
        nextDueDate: '2026-02-10',
        nextOverride: { amount: -50, overrideDate: '2026-02-25' } as any,
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('2026-02-25')).toBeInTheDocument();
    expect(screen.queryByText('2026-02-10')).not.toBeInTheDocument();
  });

  it('excludes a bill an override moved past the period end', () => {
    const bills = [
      createBill({
        id: 'st-1',
        name: 'Pushed Out',
        amount: -80,
        nextDueDate: '2026-02-20',
        nextOverride: { amount: -50, overrideDate: '2026-03-20' } as any,
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByText('Pushed Out')).not.toBeInTheDocument();
  });

  it('calculates truly available using override amounts', () => {
    const bills = [
      createBill({
        id: 'st-1',
        name: 'Modified Bill',
        amount: -80,
        nextDueDate: '2026-02-25',
        nextOverride: { amount: -50 } as any,
      }),
    ];

    // truly available = 5200 - 3000 - 50 = 2150
    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$2150.00')).toBeInTheDocument();
  });

  // ---- Effective amounts (issue #1247) ----

  it("counts a bill at the server's effective amount, not its persisted one", () => {
    const bills = [
      createBill({
        id: 'st-inv',
        name: 'Monthly ETF buy',
        // The security-currency cash impact, pinned at 1.50 when it was EUR.
        amount: -1000,
        isInvestment: true,
        // The security is USD now, and USD -> CAD resolves at 1.35.
        effectiveAmount: -1350,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'USD',
        nextDueDate: '2026-02-25',
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={0}
        totalBudgeted={2000}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    // The row and the total both read 1,350; neither reads the stale figure.
    expect(screen.getAllByText('$1350.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$1500.00')).not.toBeInTheDocument();
    // 2000 budgeted - 0 spent - 1350 upcoming.
    expect(screen.getByText('$650.00')).toBeInTheDocument();
  });

  it('withholds the total and truly-available when a bill is unresolvable', () => {
    const bills = [
      createBill({
        id: 'st-inv',
        name: 'Monthly ETF buy',
        amount: -1000,
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'USD',
        nextDueDate: '2026-02-25',
      }),
      createBill({
        id: 'st-net',
        name: 'Internet',
        amount: -80,
        effectiveAmount: -80,
        effectiveAmountComplete: true,
        nextDueDate: '2026-02-26',
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={0}
        totalBudgeted={2000}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    // Row, total and truly-available all carry the unavailable marker rather
    // than a number built on a stale figure or a silent zero.
    expect(screen.getAllByTestId('unknown-amount').length).toBe(3);
    expect(screen.queryByText('$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$1500.00')).not.toBeInTheDocument();
    // 2000 - 0 - 80 would be the answer if the unknown bill counted as free.
    expect(screen.queryByText('$1920.00')).not.toBeInTheDocument();
    // The known bill still shows its own amount.
    expect(screen.getByText('$80.00')).toBeInTheDocument();
  });

  it('excludes bills with positive override amount', () => {
    const bills = [
      createBill({
        id: 'st-1',
        name: 'Overridden Positive',
        amount: -80,
        nextDueDate: '2026-02-25',
        nextOverride: { amount: 50 } as any,
      }),
    ];

    render(
      <BudgetUpcomingBills
        scheduledTransactions={bills}
        currentSpent={3000}
        totalBudgeted={5200}
        periodEnd="2026-02-28"
        displayCurrency="USD"
      formatCurrency={mockFormat}
      />,
    );

    // Override amount is positive, so it should be filtered out (only bills with negative amounts show)
    expect(screen.queryByText('Overridden Positive')).not.toBeInTheDocument();
    expect(screen.getByText('No bills due this period.')).toBeInTheDocument();
  });
});
