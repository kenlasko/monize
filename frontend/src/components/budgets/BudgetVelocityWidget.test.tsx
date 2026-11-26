import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetVelocityWidget } from './BudgetVelocityWidget';
import type { BudgetVelocity } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const baseVelocity: BudgetVelocity = {
  dailyBurnRate: 155,
  projectedTotal: 4650,
  budgetTotal: 5200,
  projectedVariance: -550,
  safeDailySpend: 124,
  daysElapsed: 13,
  daysRemaining: 15,
  totalDays: 28,
  currentSpent: 2015,
  paceStatus: 'under',
  upcomingBills: [],
  totalUpcomingBills: 0,
  knownUpcomingBillsSubtotal: 0,
  upcomingBillsComplete: true,
  upcomingBillsMissingRates: [],
  trulyAvailable: 3185,
};

describe('BudgetVelocityWidget', () => {
  it('renders the heading', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Spending Velocity')).toBeInTheDocument();
  });

  it('displays daily burn rate', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$155.00/day')).toBeInTheDocument();
  });

  it('shows the purchase pace and the net forecast when refunds exceed purchases', () => {
    render(
      <BudgetVelocityWidget
        velocity={{ ...baseVelocity, currentSpent: -250, dailyBurnRate: 10,
          projectedTotal: 0, daysElapsed: 5, daysRemaining: 25, totalDays: 30 }}
        formatCurrency={mockFormat}
      />,
    );
    expect(screen.getByText('$10.00/day')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('displays safe daily spend', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$124.00/day')).toBeInTheDocument();
  });

  it('displays projected month-end', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$4650.00')).toBeInTheDocument();
  });

  it('displays budget total', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$5200.00')).toBeInTheDocument();
  });

  it('shows under budget pace label', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Under budget pace')).toBeInTheDocument();
  });

  it('shows on track label', () => {
    render(
      <BudgetVelocityWidget
        velocity={{ ...baseVelocity, paceStatus: 'on_track' }}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('On track')).toBeInTheDocument();
  });

  it('shows over budget pace label', () => {
    render(
      <BudgetVelocityWidget
        velocity={{ ...baseVelocity, paceStatus: 'over', projectedVariance: 500 }}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Over budget pace')).toBeInTheDocument();
  });

  it('displays day progress', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Day 13 of 28')).toBeInTheDocument();
    expect(screen.getByText('15 days remaining')).toBeInTheDocument();
  });

  it('shows upcoming bills section when bills exist', () => {
    const velocityWithBills: BudgetVelocity = {
      ...baseVelocity,
      upcomingBills: [
        { id: 'st-1', name: 'Rent', amount: 1200, currencyCode: 'USD', amountComplete: true, dueDate: '2026-02-25', categoryId: null },
      ],
      totalUpcomingBills: 1200,
      knownUpcomingBillsSubtotal: 1200,
      upcomingBillsComplete: true,
      upcomingBillsMissingRates: [],
      trulyAvailable: 1985,
    };

    render(
      <BudgetVelocityWidget velocity={velocityWithBills} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Bills coming')).toBeInTheDocument();
    expect(screen.getByText('$1200.00')).toBeInTheDocument();
    expect(screen.getByText('Truly available')).toBeInTheDocument();
    expect(screen.getByText('$1985.00')).toBeInTheDocument();
  });

  it('does not show upcoming bills section when no bills', () => {
    render(
      <BudgetVelocityWidget velocity={baseVelocity} formatCurrency={mockFormat} />,
    );

    expect(screen.queryByText('Bills coming')).not.toBeInTheDocument();
    expect(screen.queryByText('Truly available')).not.toBeInTheDocument();
  });

  // Issue #1247: an upcoming bill whose current amount cannot be determined makes
  // the bills total, truly-available and safe-daily-spend unknown, not larger.
  it('renders the unavailable marker when the upcoming-bills total is unknown', () => {
    const velocityIncomplete: BudgetVelocity = {
      ...baseVelocity,
      upcomingBills: [
        {
          id: 'st-inv',
          name: 'Monthly ETF buy',
          amount: null,
          currencyCode: 'USD',
          amountComplete: false,
          dueDate: '2026-02-25',
          categoryId: null,
        },
        {
          id: 'st-rent',
          name: 'Rent',
          amount: 1200,
          currencyCode: 'USD',
          amountComplete: true,
          dueDate: '2026-02-26',
          categoryId: null,
        },
      ],
      totalUpcomingBills: null,
      knownUpcomingBillsSubtotal: 1200,
      upcomingBillsComplete: false,
      upcomingBillsMissingRates: [],
      trulyAvailable: null,
      safeDailySpend: null,
    };

    render(
      <BudgetVelocityWidget velocity={velocityIncomplete} formatCurrency={mockFormat} />,
    );

    // The section is still drawn -- hiding it would make an unresolvable bill
    // indistinguishable from no bills at all.
    expect(screen.getByText('Bills coming')).toBeInTheDocument();
    expect(screen.getByText('Truly available')).toBeInTheDocument();
    // Bills coming, truly available and safe-to-spend are all unavailable.
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(3);
    // The known part is never shown under a total's caption.
    expect(screen.queryByText('$1200.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('shows negative truly available as over', () => {
    const velocityOverBudget: BudgetVelocity = {
      ...baseVelocity,
      upcomingBills: [
        { id: 'st-1', name: 'Big Bill', amount: 5000, currencyCode: 'USD', amountComplete: true, dueDate: '2026-02-25', categoryId: null },
      ],
      totalUpcomingBills: 5000,
      knownUpcomingBillsSubtotal: 5000,
      upcomingBillsComplete: true,
      upcomingBillsMissingRates: [],
      trulyAvailable: -1815,
    };

    render(
      <BudgetVelocityWidget velocity={velocityOverBudget} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$1815.00 over')).toBeInTheDocument();
  });
});
