import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { CreditUtilizationTotalWidget } from './CreditUtilizationTotalWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { accountIds: [] }, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (n: number) => `$${n}` }),
}));
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ convert: (n: number) => n, defaultCurrency: 'USD' }),
}));

const creditCard = (id: string, balance: number): Account =>
  ({
    id,
    name: `Card ${id}`,
    accountType: 'CREDIT_CARD',
    accountSubType: 'NONE',
    currencyCode: 'USD',
    currentBalance: balance,
    creditLimit: 1000,
    isClosed: false,
  }) as unknown as Account;

describe('CreditUtilizationTotalWidget', () => {
  it('renders the overall utilization percentage', () => {
    render(
      <CreditUtilizationTotalWidget
        accounts={[creditCard('a', -500), creditCard('b', -100)]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('Total Credit Utilization')).toBeInTheDocument();
    // used 600 / limit 2000 = 30.0%
    expect(screen.getByText('30.0%')).toBeInTheDocument();
  });

  it('shows the empty state with no credit accounts', () => {
    render(<CreditUtilizationTotalWidget accounts={[]} isLoading={false} />);
    expect(screen.getByText('No credit accounts with a limit set.')).toBeInTheDocument();
  });
});
