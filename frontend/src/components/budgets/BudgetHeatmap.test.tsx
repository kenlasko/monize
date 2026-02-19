import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetHeatmap } from './BudgetHeatmap';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetHeatmap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders heading with month label', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    expect(
      screen.getByText('Spending Heatmap - February 2026'),
    ).toBeInTheDocument();
  });

  it('renders weekday headers', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
  });

  it('renders cells for each day in the period', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-01', amount: 50 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const cell1 = screen.getByTestId('heatmap-cell-2026-02-01');
    expect(cell1).toBeInTheDocument();
    expect(cell1).toHaveTextContent('1');
  });

  it('highlights today with a ring', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const todayCell = screen.getByTestId('heatmap-cell-2026-02-15');
    expect(todayCell.className).toContain('ring-2');
  });

  it('shows spending in cell title', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-10', amount: 125.50 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const cell = screen.getByTestId('heatmap-cell-2026-02-10');
    expect(cell).toHaveAttribute('title', 'Feb 10: $125.50');
  });

  it('renders legend', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Less')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('applies heat colors based on spending amount', () => {
    render(
      <BudgetHeatmap
        dailySpending={[
          { date: '2026-02-01', amount: 0 },
          { date: '2026-02-02', amount: 100 },
        ]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const zeroCell = screen.getByTestId('heatmap-cell-2026-02-01');
    const highCell = screen.getByTestId('heatmap-cell-2026-02-02');

    // Zero spending should be gray
    expect(zeroCell.className).toContain('bg-gray-100');
    // Max spending should be red
    expect(highCell.className).toContain('bg-red-400');
  });

  it('navigates to transactions page on date click', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-10', amount: 50 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-02-10'));
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?startDate=2026-02-10&endDate=2026-02-10',
    );
  });

  it('sets active account status in localStorage on date click', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-05', amount: 30 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-02-05'));
    expect(localStorage.getItem('transactions.filter.accountStatus')).toBe(
      JSON.stringify('active'),
    );
  });

  it('renders date cells with link role', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const cell = screen.getByTestId('heatmap-cell-2026-02-01');
    expect(cell).toHaveAttribute('role', 'link');
  });
});
