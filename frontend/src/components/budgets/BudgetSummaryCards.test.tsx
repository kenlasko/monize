import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetSummaryCards } from './BudgetSummaryCards';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetSummaryCards', () => {
  it('renders all four summary cards', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={17}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Total Budget')).toBeInTheDocument();
    expect(screen.getByText('Spent')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('displays correct budget total', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={17}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$5200.00')).toBeInTheDocument();
  });

  it('displays spent amount with percentage', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={17}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$3100.00')).toBeInTheDocument();
    expect(screen.getByText('(60%)')).toBeInTheDocument();
  });

  it('displays remaining amount with days left', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={17}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('$2100.00')).toBeInTheDocument();
    expect(screen.getByText('17 days')).toBeInTheDocument();
  });

  it('shows period ended when no days remaining', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={0}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Period ended')).toBeInTheDocument();
  });

  it('shows on track when savings are positive', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={3100}
        remaining={2100}
        totalIncome={6000}
        percentUsed={59.62}
        daysRemaining={17}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('$2900.00')).toBeInTheDocument();
  });

  it('shows over budget when spending exceeds income', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={5200}
        totalSpent={7000}
        remaining={-1800}
        totalIncome={6000}
        percentUsed={134.62}
        daysRemaining={5}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
  });
});
