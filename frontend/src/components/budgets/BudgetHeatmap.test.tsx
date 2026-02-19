import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetHeatmap } from './BudgetHeatmap';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetHeatmap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));
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
});
