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
});
