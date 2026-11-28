import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import type { BudgetVelocity, UpcomingBill } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

function bill(overrides: Partial<UpcomingBill> = {}): UpcomingBill {
  return {
    id: 'st-1',
    name: 'Internet',
    amount: 80,
    currencyCode: 'USD',
    amountComplete: true,
    dueDate: '2026-02-25',
    categoryId: null,
    ...overrides,
  };
}

function velocity(
  over: Partial<BudgetVelocity> = {},
): Pick<
  BudgetVelocity,
  | 'upcomingBills'
  | 'totalUpcomingBills'
  | 'upcomingBillsMissingRates'
  | 'trulyAvailable'
> {
  return {
    upcomingBills: [],
    totalUpcomingBills: 0,
    upcomingBillsMissingRates: [],
    trulyAvailable: 5200,
    ...over,
  };
}

// The panel shows the server's answer; which occurrences are bills (a transfer
// only where a budget line takes it, nothing out of an excluded account) is
// decided by `BudgetsService.getUpcomingBills`, covered on the backend.
describe('BudgetUpcomingBills', () => {
  it('renders the heading and the empty state', () => {
    render(<BudgetUpcomingBills velocity={velocity()} formatCurrency={mockFormat} />);

    expect(screen.getByText('Upcoming Bills')).toBeInTheDocument();
    expect(screen.getByText('No bills due this period.')).toBeInTheDocument();
  });

  it("lists the server's bills with their total and truly available", () => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [
            bill(),
            bill({ id: 'st-2', name: 'Insurance', amount: 150, dueDate: '2026-02-28' }),
          ],
          totalUpcomingBills: 230,
          trulyAvailable: 2120,
        })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Internet')).toBeInTheDocument();
    expect(screen.getByText('Insurance')).toBeInTheDocument();
    expect(screen.getByText('2026-02-28')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('$230.00')).toBeInTheDocument();
    expect(screen.getByText('$2120.00')).toBeInTheDocument();
  });

  it('shows a transfer the server left out of the bills as nothing', () => {
    // The server sends no row and no amount for a transfer no budget line takes.
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill()],
          totalUpcomingBills: 80,
          trulyAvailable: 2120,
        })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getAllByText('$80.00')).toHaveLength(2);
    expect(screen.queryByText(/transfer/i)).not.toBeInTheDocument();
  });

  it('does not paint a zero-amount row as a bill', () => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill({ name: 'Card Payment', amount: 0 })],
        })}
        formatCurrency={mockFormat}
      />,
    );

    const amount = screen.getAllByText('$0.00')[0];
    expect(amount.className).not.toContain('text-red-600');
    expect(amount.className).toContain('text-gray-500');
  });

  it("prints a row in the occurrence's own currency", () => {
    const formatted: Array<[number, string | undefined]> = [];
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill({ amount: 100, currencyCode: 'CAD' })],
          totalUpcomingBills: 75,
        })}
        formatCurrency={(amount, currency) => {
          formatted.push([amount, currency]);
          return `${currency ?? 'budget'} ${amount}`;
        }}
      />,
    );

    expect(formatted).toContainEqual([100, 'CAD']);
    expect(screen.getByText('budget 75')).toBeInTheDocument();
  });

  it('shows an overflow indicator past five bills', () => {
    const bills = Array.from({ length: 7 }, (_, i) =>
      bill({ id: `st-${i}`, name: `Bill ${i + 1}`, amount: 50 }),
    );

    render(
      <BudgetUpcomingBills
        velocity={velocity({ upcomingBills: bills, totalUpcomingBills: 350 })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Bill 5')).toBeInTheDocument();
    expect(screen.queryByText('Bill 6')).not.toBeInTheDocument();
    expect(screen.getByText('+2 more bills')).toBeInTheDocument();
  });

  it('marks an overspent budget', () => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill()],
          totalUpcomingBills: 80,
          trulyAvailable: -40,
        })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText(/\$40\.00/)).toBeInTheDocument();
  });

  // Issue #1247: a total is only a total when every bill is known.
  it('shows the total and truly available as unknown, never zero, when the server withholds them', () => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill({ amount: null, amountComplete: false })],
          totalUpcomingBills: null,
          trulyAvailable: null,
        })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$80.00')).not.toBeInTheDocument();
    // The row, the total and truly available.
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(3);
  });
});
