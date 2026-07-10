import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BankingSummaryCards } from './BankingSummaryCards';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'chq-1',
    accountType: 'CHEQUING',
    name: 'Everyday',
    currencyCode: 'CAD',
    currentBalance: 1500,
    interestRate: null,
    ...overrides,
  } as Account;
}

const base = {
  projectedBalance: 1800,
  moneyIn: 2000,
  moneyOut: 1400,
  interestEarnedYtd: 0,
  averageBalance: 1600,
};

describe('BankingSummaryCards', () => {
  it('renders the core figures', () => {
    render(<BankingSummaryCards account={makeAccount()} {...base} />);
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    expect(screen.getByText('$1800.00')).toBeInTheDocument();
    expect(screen.getByText('$2000.00')).toBeInTheDocument();
    expect(screen.getByText('$1600.00')).toBeInTheDocument();
  });

  it('omits interest cards when there is no rate or earnings', () => {
    render(<BankingSummaryCards account={makeAccount()} {...base} />);
    expect(screen.queryByText('Interest Rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Interest Earned')).not.toBeInTheDocument();
  });

  it('shows interest cards when populated', () => {
    render(
      <BankingSummaryCards
        account={makeAccount({ interestRate: 2.25 })}
        {...base}
        interestEarnedYtd={30}
      />,
    );
    expect(screen.getByText('2.25%')).toBeInTheDocument();
    expect(screen.getByText('Interest Earned')).toBeInTheDocument();
    expect(screen.getByText('$30.00')).toBeInTheDocument();
  });
});
