import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import type { BudgetVelocity, UpcomingBill } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

function bill(overrides: Partial<UpcomingBill> = {}): UpcomingBill {
  return {
    id: 'st-1',
    name: 'Internet',
    amount: 80,
    amountDue: 80,
    isReminder: false,
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
            bill({ id: 'st-2', name: 'Insurance', amount: 150, amountDue: 150, dueDate: '2026-02-28' }),
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

  // The server sends no row for a transfer no budget line takes, nor for a
  // split made only of such transfer lines: they are transfers, not bills.
  it('lists only the rows the server sends, so a transfer the budget does not track is no bill', () => {
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

  it('shows what is due, and counts only the spending part', () => {
    // A 100 loan payment: 30 interest and a 70 principal transfer line.
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill({ name: 'Loan', amount: 30, amountDue: 100 })],
          totalUpcomingBills: 30,
          trulyAvailable: 5170,
        })}
        formatCurrency={mockFormat}
      />,
    );

    // The row prints the whole $100.00 due; the total counts the $30.00.
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$30.00')).toBeInTheDocument();
  });

  // Issue #1124: a bill left at 0 because the amount varies month to month is
  // still a payment to make; it adds nothing to the total and is not red.
  it('shows a zero-amount reminder without adding it to the total', () => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [
            bill(),
            bill({
              id: 'st-2',
              name: 'Card Payment',
              amount: 0,
              amountDue: 0,
              isReminder: true,
            }),
          ],
          totalUpcomingBills: 80,
          trulyAvailable: 2120,
        })}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Card Payment')).toBeInTheDocument();
    // The $80 bill's row and the total.
    expect(screen.getAllByText('$80.00')).toHaveLength(2);
    expect(screen.getByText('$2120.00')).toBeInTheDocument();
    const reminder = screen.getByText('$0.00');
    expect(reminder.className).not.toContain('text-red-600');
    expect(reminder.className).toContain('text-gray-500');
  });

  it("prints a row in the occurrence's own currency", () => {
    const formatted: Array<[number, string | undefined]> = [];
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill({ amount: 100, amountDue: 100, currencyCode: 'CAD' })],
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
          upcomingBills: [bill({ amount: null, amountDue: null, amountComplete: false })],
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

  // Audit #2365 p: what is left is unknown when the SPENDING or the BUDGET is,
  // with that cause's own pairs; the panel only reads the server's flags.
  it.each([
    ['spending', { spendingComplete: false, spendingMissingRatePairs: ['QQQ->USD'] }, 'QQQ->USD'],
    ['the budget', { budgetedComplete: false, budgetedMissingRatePairs: ['JPY->CAD'] }, 'JPY->CAD'],
  ])('shows truly available as unknown with the cause when %s is unknown', (_name, flags, pair) => {
    render(
      <BudgetUpcomingBills
        velocity={velocity({
          upcomingBills: [bill()],
          totalUpcomingBills: 80,
          trulyAvailable: null,
          ...flags,
        })}
        formatCurrency={mockFormat}
      />,
    );

    // The bills total is a figure; only truly available is unknown.
    expect(screen.getByText('$80.00', { selector: 'span.font-semibold' })).toBeInTheDocument();
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(1);
    // The cause is the tooltip's text, opened on focus.
    fireEvent.focus(screen.getByTestId('unknown-amount').querySelector('button')!);
    expect(document.body.textContent).toContain(pair);
  });
});
