import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetStatusWidget } from './BudgetStatusWidget';
import type { DashboardBudgetSummary } from '@/types/budget';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

const mockGetDashboardSummary = vi.fn();
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getDashboardSummary: (...args: any[]) => mockGetDashboardSummary(...args),
  },
}));

const mockSummary: DashboardBudgetSummary = {
  budgetId: 'budget-123',
  budgetName: 'February Budget',
  totalBudgeted: 3000,
  totalSpent: 1800,
  remaining: 1200,
  percentUsed: 60,
  safeDailySpend: 85.71,
  daysRemaining: 14,
  topCategories: [
    { categoryName: 'Groceries', budgeted: 600, spent: 550, remaining: 50, percentUsed: 91.67 },
    { categoryName: 'Dining Out', budgeted: 400, spent: 450, remaining: -50, percentUsed: 112.5 },
    { categoryName: 'Transport', budgeted: 200, spent: 80, remaining: 120, percentUsed: 40 },
  ],
};

describe('BudgetStatusWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDashboardSummary.mockResolvedValue(mockSummary);
  });

  it('shows loading skeleton when parent is loading', () => {
    render(<BudgetStatusWidget isLoading={true} />);

    expect(screen.getByText('Budget Status')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('does not fetch data while parent is loading', () => {
    render(<BudgetStatusWidget isLoading={true} />);

    expect(mockGetDashboardSummary).not.toHaveBeenCalled();
  });

  it('shows loading skeleton while fetching data', () => {
    // Never resolve to keep it in loading state
    mockGetDashboardSummary.mockReturnValue(new Promise(() => {}));

    render(<BudgetStatusWidget isLoading={false} />);

    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows "No active budget found" when API returns null', async () => {
    mockGetDashboardSummary.mockResolvedValue(null);

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(
        screen.getByText('No active budget found. Create a budget to track your spending.'),
      ).toBeInTheDocument();
    });
  });

  it('shows "No active budget found" on API error', async () => {
    mockGetDashboardSummary.mockRejectedValue(new Error('Network error'));

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(
        screen.getByText('No active budget found. Create a budget to track your spending.'),
      ).toBeInTheDocument();
    });
  });

  it('renders budget summary with correct percentages', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    expect(screen.getByText('$1800.00 / $3000.00')).toBeInTheDocument();
  });

  it('renders safe daily spend callout', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Safe to spend today')).toBeInTheDocument();
    });

    expect(screen.getByText('$85.71')).toBeInTheDocument();
  });

  it('renders top 3 categories with progress bars', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Top Categories')).toBeInTheDocument();
    });

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining Out')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();

    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('113%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('applies red color for categories over 100%', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('113%')).toBeInTheDocument();
    });

    const overBudgetPercent = screen.getByText('113%');
    expect(overBudgetPercent.className).toContain('text-red');
  });

  it('applies amber color for categories between 80% and 100%', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('92%')).toBeInTheDocument();
    });

    const warningPercent = screen.getByText('92%');
    expect(warningPercent.className).toContain('text-amber');
  });

  it('applies green color for categories below 80%', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('40%')).toBeInTheDocument();
    });

    const safePercent = screen.getByText('40%');
    expect(safePercent.className).toContain('text-emerald');
  });

  it('applies correct color to the overall percentage text', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    const overallPercent = screen.getByText('60%');
    expect(overallPercent.className).toContain('text-emerald');
  });

  it('applies red color to overall percentage when over 100%', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      percentUsed: 115,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('115%')).toBeInTheDocument();
    });

    const overallPercent = screen.getByText('115%');
    expect(overallPercent.className).toContain('text-red');
  });

  it('applies amber color to overall percentage when between 80% and 100%', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      percentUsed: 85,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('85%')).toBeInTheDocument();
    });

    const overallPercent = screen.getByText('85%');
    expect(overallPercent.className).toContain('text-amber');
  });

  it('navigates to budget detail page when title is clicked', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Budget Status'));

    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('navigates to budget detail page when "View full budget" is clicked', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('View full budget')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('View full budget'));

    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('navigates to budgets page when "Create Budget" is clicked (no budget)', async () => {
    mockGetDashboardSummary.mockResolvedValue(null);

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Create Budget')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Budget'));

    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  it('navigates to budgets page when title is clicked in loading state', () => {
    render(<BudgetStatusWidget isLoading={true} />);

    fireEvent.click(screen.getByText('Budget Status'));

    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  it('navigates to budgets page when title is clicked in empty state', async () => {
    mockGetDashboardSummary.mockResolvedValue(null);

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(
        screen.getByText('No active budget found. Create a budget to track your spending.'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Budget Status'));

    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  it('shows days remaining', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('14 days left')).toBeInTheDocument();
    });
  });

  it('shows 1 day remaining correctly', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      daysRemaining: 1,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('1 days left')).toBeInTheDocument();
    });
  });

  it('renders progress bar with correct width', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    const progressBars = document.querySelectorAll('.rounded-full.h-2');
    const innerBar = Array.from(progressBars).find(
      (el) => (el as HTMLElement).style.width === '60%',
    );
    expect(innerBar).toBeTruthy();
  });

  it('clamps progress bar width to 100% when over budget', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      percentUsed: 150,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('150%')).toBeInTheDocument();
    });

    const progressBars = document.querySelectorAll('.rounded-full.h-2');
    const innerBar = Array.from(progressBars).find(
      (el) => (el as HTMLElement).style.width === '100%',
    );
    expect(innerBar).toBeTruthy();
  });

  it('applies red progress bar color when over 100%', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      percentUsed: 110,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('110%')).toBeInTheDocument();
    });

    const progressBars = document.querySelectorAll('.rounded-full.h-2.transition-all');
    const redBar = Array.from(progressBars).find((el) =>
      el.className.includes('bg-red-500'),
    );
    expect(redBar).toBeTruthy();
  });

  it('applies amber progress bar color when between 80% and 100%', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      percentUsed: 90,
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('90%')).toBeInTheDocument();
    });

    const progressBars = document.querySelectorAll('.rounded-full.h-2.transition-all');
    const amberBar = Array.from(progressBars).find((el) =>
      el.className.includes('bg-amber-500'),
    );
    expect(amberBar).toBeTruthy();
  });

  it('applies green progress bar color when below 80%', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    const progressBars = document.querySelectorAll('.rounded-full.h-2.transition-all');
    const greenBar = Array.from(progressBars).find((el) =>
      el.className.includes('bg-emerald-500'),
    );
    expect(greenBar).toBeTruthy();
  });

  it('does not render Top Categories section when no categories', async () => {
    mockGetDashboardSummary.mockResolvedValue({
      ...mockSummary,
      topCategories: [],
    });

    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    expect(screen.queryByText('Top Categories')).not.toBeInTheDocument();
  });

  it('fetches data after parent loading completes', async () => {
    const { rerender } = render(<BudgetStatusWidget isLoading={true} />);

    expect(mockGetDashboardSummary).not.toHaveBeenCalled();

    rerender(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(mockGetDashboardSummary).toHaveBeenCalledTimes(1);
    });
  });

  it('renders category progress bars with correct colors', async () => {
    render(<BudgetStatusWidget isLoading={false} />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    const categoryBars = document.querySelectorAll('.rounded-full.h-1\\.5');
    const barClasses = Array.from(categoryBars).map((el) => el.className);

    // Groceries (91.67%) should have amber bar
    const amberBars = barClasses.filter((c) => c.includes('bg-amber-400'));
    expect(amberBars.length).toBeGreaterThanOrEqual(1);

    // Dining Out (112.5%) should have red bar
    const redBars = barClasses.filter((c) => c.includes('bg-red-400'));
    expect(redBars.length).toBeGreaterThanOrEqual(1);

    // Transport (40%) should have green bar
    const greenBars = barClasses.filter((c) => c.includes('bg-emerald-400'));
    expect(greenBars.length).toBeGreaterThanOrEqual(1);
  });
});
