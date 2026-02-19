import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetZeroBasedBar } from './BudgetZeroBasedBar';

const formatCurrency = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetZeroBasedBar', () => {
  it('renders the heading', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Zero-Based Assignment')).toBeInTheDocument();
  });

  it('shows "Fully assigned" when budgeted matches income', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Fully assigned')).toBeInTheDocument();
  });

  it('shows "Fully assigned" within 2% tolerance', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={4950}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Fully assigned')).toBeInTheDocument();
  });

  it('shows "Under-assigned" when significant unassigned amount', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={3000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Under-assigned')).toBeInTheDocument();
    expect(screen.getByText('$2000.00 unassigned')).toBeInTheDocument();
  });

  it('shows "Over-assigned" when budgeted exceeds income', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={6000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Over-assigned')).toBeInTheDocument();
    expect(screen.getByText('$1000.00 over')).toBeInTheDocument();
  });

  it('displays assigned and total amounts', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={5000}
        totalBudgeted={3500}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Assigned: $3500.00 / $5000.00')).toBeInTheDocument();
  });

  it('handles zero income', () => {
    render(
      <BudgetZeroBasedBar
        totalIncome={0}
        totalBudgeted={0}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Fully assigned')).toBeInTheDocument();
  });
});
