import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BankingSummaryCards } from './BankingSummaryCards';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});
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

  // Discussion #1784: when overdue occurrences moved the projection, the note
  // under it says so.
  it('notes overdue scheduled transactions under the projected balance', () => {
    render(
      <BankingSummaryCards
        account={makeAccount()}
        {...base}
        overdue={{ date: '2026-03-02', count: 2, amount: -300 }}
      />,
    );
    expect(screen.getByText('Includes 2 overdue scheduled transactions')).toBeInTheDocument();
  });

  it('keeps the plain note when nothing is overdue', () => {
    render(<BankingSummaryCards account={makeAccount()} {...base} overdue={null} />);
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  it('drops the overdue note when there is no projected balance', () => {
    render(
      <BankingSummaryCards
        account={makeAccount()}
        {...base}
        projectedBalance={null}
        overdue={{ date: '2026-03-02', count: 1, amount: -300 }}
      />,
    );
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  it('shows an unavailable money in and out as a marker saying it could not be loaded, never as zero or a rate problem', () => {
    render(<BankingSummaryCards account={makeAccount()} {...base} moneyIn={null} moneyOut={null} />);
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(2);
    expect(screen.getAllByLabelText(/could not be loaded/i)).toHaveLength(2);
    expect(screen.queryByLabelText(/no exchange rate is available/i)).not.toBeInTheDocument();
  });
});
