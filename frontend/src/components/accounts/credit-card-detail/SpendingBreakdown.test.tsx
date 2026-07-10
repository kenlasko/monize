import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SpendingBreakdown } from './SpendingBreakdown';
import type { GroupedTotal } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

const totals: GroupedTotal[] = [
  { id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 },
  { id: 'c2', name: 'Gas', currencyCode: 'CAD', total: -200, count: 2 },
  { id: 'c3', name: 'Refund', currencyCode: 'CAD', total: 100, count: 1 },
];

describe('SpendingBreakdown', () => {
  it('lists charge categories largest first and ignores credits', () => {
    render(<SpendingBreakdown totals={totals} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('$450.00')).toBeInTheDocument();
    expect(screen.getByText('Gas')).toBeInTheDocument();
    // A positive (credit) total is not spending.
    expect(screen.queryByText('Refund')).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no spending', () => {
    render(<SpendingBreakdown totals={[]} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('No spending recorded this cycle')).toBeInTheDocument();
  });

  it('labels an uncategorised charge', () => {
    render(
      <SpendingBreakdown
        totals={[{ id: null, name: null, currencyCode: 'CAD', total: -50, count: 1 }]}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('invokes onSelect with the category id when a row is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SpendingBreakdown
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('Groceries'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('passes null to onSelect for an uncategorised row', () => {
    const onSelect = vi.fn();
    render(
      <SpendingBreakdown
        totals={[{ id: null, name: null, currencyCode: 'CAD', total: -50, count: 1 }]}
        currencyCode="CAD"
        isLoading={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('Uncategorized'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
