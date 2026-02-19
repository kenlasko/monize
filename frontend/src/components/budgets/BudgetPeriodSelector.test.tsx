import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetPeriodSelector } from './BudgetPeriodSelector';
import type { BudgetPeriod } from '@/types/budget';

const mockPeriods: BudgetPeriod[] = [
  {
    id: 'period-1',
    budgetId: 'budget-1',
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    actualIncome: 5000,
    actualExpenses: 3000,
    totalBudgeted: 5200,
    status: 'OPEN',
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
  {
    id: 'period-2',
    budgetId: 'budget-1',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    actualIncome: 5000,
    actualExpenses: 4800,
    totalBudgeted: 5200,
    status: 'CLOSED',
    createdAt: '2026-01-01',
    updatedAt: '2026-02-01',
  },
];

describe('BudgetPeriodSelector', () => {
  it('renders when there are multiple periods', () => {
    render(
      <BudgetPeriodSelector
        periods={mockPeriods}
        selectedPeriodId={null}
        onPeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Period:')).toBeInTheDocument();
  });

  it('returns null when there is only one period', () => {
    const { container } = render(
      <BudgetPeriodSelector
        periods={[mockPeriods[0]]}
        selectedPeriodId={null}
        onPeriodChange={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('returns null when there are no periods', () => {
    const { container } = render(
      <BudgetPeriodSelector
        periods={[]}
        selectedPeriodId={null}
        onPeriodChange={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('shows Current Period as default option', () => {
    render(
      <BudgetPeriodSelector
        periods={mockPeriods}
        selectedPeriodId={null}
        onPeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Current Period')).toBeInTheDocument();
  });

  it('shows period labels with status', () => {
    render(
      <BudgetPeriodSelector
        periods={mockPeriods}
        selectedPeriodId={null}
        onPeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Feb 2026 (Current)')).toBeInTheDocument();
    expect(screen.getByText('Jan 2026')).toBeInTheDocument();
  });

  it('calls onPeriodChange when selection changes', () => {
    const handleChange = vi.fn();
    render(
      <BudgetPeriodSelector
        periods={mockPeriods}
        selectedPeriodId={null}
        onPeriodChange={handleChange}
      />,
    );

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'period-2' } });

    expect(handleChange).toHaveBeenCalledWith('period-2');
  });

  it('calls onPeriodChange with null when Current Period selected', () => {
    const handleChange = vi.fn();
    render(
      <BudgetPeriodSelector
        periods={mockPeriods}
        selectedPeriodId="period-2"
        onPeriodChange={handleChange}
      />,
    );

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '' } });

    expect(handleChange).toHaveBeenCalledWith(null);
  });
});
