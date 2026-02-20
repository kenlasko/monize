import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetDashboard } from './BudgetDashboard';
import type { BudgetSummary, BudgetVelocity, Budget } from '@/types/budget';

// Mock child components
vi.mock('./BudgetSummaryCards', () => ({
  BudgetSummaryCards: (props: any) => (
    <div data-testid="summary-cards">
      <span data-testid="total-budgeted">{props.totalBudgeted}</span>
    </div>
  ),
}));

vi.mock('./BudgetHealthGauge', () => ({
  BudgetHealthGauge: ({ score }: { score: number }) => (
    <div data-testid="health-gauge">{score}</div>
  ),
}));

vi.mock('./BudgetVelocityWidget', () => ({
  BudgetVelocityWidget: () => <div data-testid="velocity-widget" />,
}));

let capturedCategoryListProps: any = {};
vi.mock('./BudgetCategoryList', () => ({
  BudgetCategoryList: (props: any) => {
    capturedCategoryListProps = props;
    return <div data-testid="category-list" />;
  },
}));

vi.mock('./BudgetFlexGroupCard', () => ({
  BudgetFlexGroupCard: () => <div data-testid="flex-group-card" />,
}));

vi.mock('./BudgetUpcomingBills', () => ({
  BudgetUpcomingBills: () => <div data-testid="upcoming-bills" />,
}));

vi.mock('./BudgetHeatmap', () => ({
  BudgetHeatmap: () => <div data-testid="heatmap" />,
}));

vi.mock('./BudgetTrendChart', () => ({
  BudgetTrendChart: () => <div data-testid="trend-chart" />,
}));

const mockBudget: Budget = {
  id: 'budget-1',
  userId: 'user-1',
  name: 'February 2026',
  description: null,
  budgetType: 'MONTHLY',
  periodStart: '2026-02-01',
  periodEnd: '2026-02-28',
  baseIncome: 6000,
  incomeLinked: false,
  strategy: 'FIXED',
  isActive: true,
  currencyCode: 'USD',
  config: {},
  categories: [],
  createdAt: '2026-02-01',
  updatedAt: '2026-02-01',
};

const mockSummary: BudgetSummary = {
  budget: mockBudget,
  totalBudgeted: 5200,
  totalSpent: 3100,
  totalIncome: 6000,
  remaining: 2100,
  percentUsed: 59.62,
  incomeLinked: false,
  actualIncome: null,
  categoryBreakdown: [
    {
      budgetCategoryId: 'bc-1',
      categoryId: 'cat-1',
      categoryName: 'Groceries',
      budgeted: 600,
      spent: 420,
      remaining: 180,
      percentUsed: 70,
      isIncome: false,
      percentage: null,
    },
  ],
};

const mockVelocity: BudgetVelocity = {
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
  trulyAvailable: 0,
};

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetDashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));
    capturedCategoryListProps = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all dashboard widgets', () => {
    render(
      <BudgetDashboard
        summary={mockSummary}
        velocity={mockVelocity}
        scheduledTransactions={[]}
        dailySpending={[]}
        trendData={[]}
        healthScore={85}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
    expect(screen.getByTestId('health-gauge')).toBeInTheDocument();
    expect(screen.getByTestId('velocity-widget')).toBeInTheDocument();
    expect(screen.getByTestId('category-list')).toBeInTheDocument();
    expect(screen.getByTestId('flex-group-card')).toBeInTheDocument();
    expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
    expect(screen.getByTestId('heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
  });

  it('passes correct budget total to summary cards', () => {
    render(
      <BudgetDashboard
        summary={mockSummary}
        velocity={mockVelocity}
        scheduledTransactions={[]}
        dailySpending={[]}
        trendData={[]}
        healthScore={85}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByTestId('total-budgeted')).toHaveTextContent('5200');
  });

  it('passes health score to gauge', () => {
    render(
      <BudgetDashboard
        summary={mockSummary}
        velocity={mockVelocity}
        scheduledTransactions={[]}
        dailySpending={[]}
        trendData={[]}
        healthScore={92}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByTestId('health-gauge')).toHaveTextContent('92');
  });

  it('passes onCategoryClick to BudgetCategoryList', () => {
    const mockOnCategoryClick = vi.fn();

    render(
      <BudgetDashboard
        summary={mockSummary}
        velocity={mockVelocity}
        scheduledTransactions={[]}
        dailySpending={[]}
        trendData={[]}
        healthScore={85}
        formatCurrency={mockFormat}
        onCategoryClick={mockOnCategoryClick}
      />,
    );

    expect(capturedCategoryListProps.onCategoryClick).toBe(mockOnCategoryClick);
  });

  it('does not pass onCategoryClick when not provided', () => {
    render(
      <BudgetDashboard
        summary={mockSummary}
        velocity={mockVelocity}
        scheduledTransactions={[]}
        dailySpending={[]}
        trendData={[]}
        healthScore={85}
        formatCurrency={mockFormat}
      />,
    );

    expect(capturedCategoryListProps.onCategoryClick).toBeUndefined();
  });
});
