import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CreditCardSummaryCards } from './CreditCardSummaryCards';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'cc-1',
    accountType: 'CREDIT_CARD',
    name: 'My Visa',
    currencyCode: 'CAD',
    currentBalance: -1500,
    creditLimit: 5000,
    interestRate: 19.99,
    ...overrides,
  } as Account;
}

describe('CreditCardSummaryCards', () => {
  it('shows balance, limit, available credit, utilization and rate', () => {
    render(<CreditCardSummaryCards account={makeAccount()} />);
    expect(screen.getByText('$1500.00')).toBeInTheDocument(); // abs balance
    expect(screen.getByText('$5000.00')).toBeInTheDocument(); // limit
    expect(screen.getByText('$3500.00')).toBeInTheDocument(); // available
    expect(screen.getByText('30.0%')).toBeInTheDocument(); // utilization
    expect(screen.getByText('19.99%')).toBeInTheDocument();
  });

  it('shows Not set for a card without a limit or rate', () => {
    render(<CreditCardSummaryCards account={makeAccount({ creditLimit: null, interestRate: null })} />);
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(2);
    // No utilization card without a limit.
    expect(screen.queryByText('Utilization')).not.toBeInTheDocument();
  });
});
