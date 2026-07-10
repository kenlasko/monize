import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { PayoffCalculator } from './PayoffCalculator';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: Date) => `${d.getFullYear()}` }),
}));

describe('PayoffCalculator', () => {
  it('projects a payoff for a carried balance', () => {
    render(<PayoffCalculator balance={1000} interestRate={12} currencyCode="CAD" />);
    expect(screen.getByText('Payoff Calculator')).toBeInTheDocument();
    expect(screen.getByText('Paid off in')).toBeInTheDocument();
    expect(screen.getByText('Total Interest')).toBeInTheDocument();
  });

  it('warns when the payment never clears the balance', () => {
    render(<PayoffCalculator balance={1000} interestRate={24} currencyCode="CAD" />);
    const input = screen.getByLabelText('Monthly Payment');
    fireEvent.change(input, { target: { value: '5' } });
    expect(
      screen.getByText(/never clears/),
    ).toBeInTheDocument();
  });

  it('shows a no-balance message when nothing is owed', () => {
    render(<PayoffCalculator balance={0} interestRate={19.99} currencyCode="CAD" />);
    expect(screen.getByText('This card has no balance to pay off.')).toBeInTheDocument();
  });
});
