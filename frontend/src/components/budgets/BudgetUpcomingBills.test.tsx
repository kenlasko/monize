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
    description: null,
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
        formatCurrency={mockFormat}
      />,
    );

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
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.queryByText('Deposit')).not.toBeInTheDocument();
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
        formatCurrency={mockFormat}
      />,
    );

    // Should show override amount (50), not default (80) - appears in item row and total
    const amounts = screen.getAllByText('$50.00');
    expect(amounts.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('$80.00')).not.toBeInTheDocument();
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
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$2150.00')).toBeInTheDocument();
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
        formatCurrency={mockFormat}
      />,
    );

    // Override amount is positive, so it should be filtered out (only bills with negative amounts show)
    expect(screen.queryByText('Overridden Positive')).not.toBeInTheDocument();
    expect(screen.getByText('No bills due this period.')).toBeInTheDocument();
  });
});
