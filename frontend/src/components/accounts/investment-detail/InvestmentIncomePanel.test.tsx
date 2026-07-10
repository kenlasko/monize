import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { InvestmentIncomePanel } from './InvestmentIncomePanel';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

describe('InvestmentIncomePanel', () => {
  it('shows dividends/interest and realized gains', () => {
    render(
      <InvestmentIncomePanel
        dividendInterestYtd={60}
        realizedGainsYtd={100}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('Dividends & Interest')).toBeInTheDocument();
    expect(screen.getByText('$60.00')).toBeInTheDocument();
    expect(screen.getByText('Realized Gains')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('shows an empty state when there is no income', () => {
    render(
      <InvestmentIncomePanel
        dividendInterestYtd={0}
        realizedGainsYtd={0}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('No investment income this year')).toBeInTheDocument();
  });
});
