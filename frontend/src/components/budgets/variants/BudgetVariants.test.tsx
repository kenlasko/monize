import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { BudgetSummaryFolio } from './BudgetSummaryFolio';
import { BudgetSummaryPebble } from './BudgetSummaryPebble';
import { BudgetCategoryListFolio } from './BudgetCategoryListFolio';
import { BudgetCategoryListPebble } from './BudgetCategoryListPebble';
import { BudgetVelocityPebble } from './BudgetVelocityPebble';
import { BudgetListPebble } from './BudgetListPebble';
import type { BudgetSummaryViewProps } from './budget-summary-view';
import type { BudgetCategoryListViewProps } from './budget-category-list-view';
import type { Budget, BudgetVelocity } from '@/types/budget';

const fmt = (n: number) => `$${n.toFixed(2)}`;

const summary: BudgetSummaryViewProps = {
  totalBudgeted: 5200,
  totalSpent: 3100,
  remaining: 2100,
  totalIncome: 6000,
  percentUsed: 59.6,
  daysRemaining: 17,
  displayCurrency: 'USD',
  formatCurrency: fmt,
};

describe.each([
  ['Folio', BudgetSummaryFolio],
  ['Pebble', BudgetSummaryPebble],
])('BudgetSummary%s', (_n, Variant) => {
  it('labels the four totals and exposes the spend gauge', () => {
    render(<Variant {...summary} />);
    expect(screen.getByRole('region', { name: 'Budget totals' })).toBeInTheDocument();
    for (const label of ['Total Budget', 'Spent', 'Remaining', 'Savings']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('17 days')).toBeInTheDocument();
  });

  it('keeps an overspend visible as its own state', () => {
    render(<Variant {...summary} totalSpent={6000} totalIncome={1000} remaining={-800} percentUsed={115} />);
    expect(screen.getAllByText('Over budget').length).toBeGreaterThan(0);
  });
});

const list: BudgetCategoryListViewProps = {
  rows: [
    {
      category: {
        budgetCategoryId: 'bc-1',
        categoryId: 'c-1',
        categoryName: 'Groceries',
        budgeted: 600,
        spent: 700,
        remaining: -100,
        percentUsed: 116,
        isIncome: false,
        isTransfer: false,
        percentage: null,
      },
      rolloverType: 'MONTHLY',
      flexGroup: 'Needs',
    },
  ],
  formatCurrency: fmt,
  pacePercent: 50,
  onCategoryClick: vi.fn(),
  sortField: 'percentUsed',
  sortDirection: 'desc',
  onSort: vi.fn(),
};

describe.each([
  ['Folio', BudgetCategoryListFolio],
  ['Pebble', BudgetCategoryListPebble],
])('BudgetCategoryList%s', (_n, Variant) => {
  it('shows the carried deficit without a percentage or pace marker', () => {
    const category = { ...list.rows[0].category, budgeted: -100, spent: 120, remaining: -220, percentUsed: 0 };
    render(<Variant {...list} rows={[{ category }]} />);

    expect(screen.getByText(/\$220\.00/)).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pace-marker')).not.toBeInTheDocument();
  });

  it('shows the line and opens it from a real button', async () => {
    const onCategoryClick = vi.fn();
    render(<Variant {...list} onCategoryClick={onCategoryClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Groceries/ }));
    expect(onCategoryClick).toHaveBeenCalledWith('bc-1');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});

describe('BudgetCategoryListFolio columns', () => {
  it('sets Budgeted, Spent and Remaining in their own columns', () => {
    render(<BudgetCategoryListFolio {...list} />);
    expect(screen.getByRole('columnheader', { name: 'Budgeted' })).toBeInTheDocument();
    expect(screen.getByText('$600.00')).toBeInTheDocument();
    expect(screen.getByText('$700.00')).toBeInTheDocument();
    expect(screen.getByText('($100.00)')).toBeInTheDocument();
  });
});

describe('BudgetVelocityPebble', () => {
  const velocity: BudgetVelocity = {
    dailyBurnRate: 155,
    projectedTotal: 4650,
    budgetTotal: 5200,
    projectedVariance: -550,
    safeDailySpend: null,
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

  it('keeps an unknown safe-to-spend unknown, not zero', () => {
    render(<BudgetVelocityPebble velocity={velocity} formatCurrency={fmt} />);
    expect(screen.getByText('Safe to spend')).toBeInTheDocument();
    expect(screen.queryByText('$0.00/day')).not.toBeInTheDocument();
  });
});

describe('BudgetListPebble', () => {
  const budget = {
    id: 'b1',
    name: 'November Budget',
    strategy: 'FIXED',
    budgetType: 'MONTHLY',
    isActive: true,
    periodStart: '2026-11-01',
    categories: [{}, {}],
  } as unknown as Budget;

  it('opens a budget from its block', async () => {
    const onOpen = vi.fn();
    render(<BudgetListPebble budgets={[budget]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /November Budget/ }));
    expect(onOpen).toHaveBeenCalledWith(budget);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
