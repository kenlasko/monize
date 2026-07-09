import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopGroupsPanel } from './TopGroupsPanel';
import type { GroupedTotal } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

const totals: GroupedTotal[] = [
  { id: 'c1', name: 'Rent', currencyCode: 'CAD', total: -1200, count: 1 },
  { id: 'c2', name: 'Salary', currencyCode: 'CAD', total: 3000, count: 1 },
  { id: null, name: null, currencyCode: 'CAD', total: -30, count: 1 },
];

describe('TopGroupsPanel', () => {
  it('ranks groups by magnitude and colours by sign', () => {
    render(
      <TopGroupsPanel
        title="Top Categories"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    const items = screen.getAllByRole('listitem');
    // Salary (3000) ranks above Rent (1200).
    expect(items[0]).toHaveTextContent('Salary');
    expect(items[1]).toHaveTextContent('Rent');
    expect(screen.getByText('Uncategorised')).toBeInTheDocument();
  });

  it('calls onSelect with the group id for identified rows only', () => {
    const onSelect = vi.fn();
    render(
      <TopGroupsPanel
        title="Top Categories"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('Salary'));
    expect(onSelect).toHaveBeenCalledWith('c2');
    // The uncategorised (null id) row is not a button by default.
    expect(screen.getByText('Uncategorised').closest('button')).toBeNull();
  });

  it('lets the unidentified row be selected when opted in', () => {
    const onSelect = vi.fn();
    render(
      <TopGroupsPanel
        title="Top Categories"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
        onSelect={onSelect}
        selectableWhenUnidentified
      />,
    );
    fireEvent.click(screen.getByText('Uncategorised'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows the empty label when there is nothing to rank', () => {
    render(
      <TopGroupsPanel
        title="Top Payees"
        emptyLabel="No payee activity"
        fallbackLabel="Uncategorised"
        totals={[]}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('No payee activity')).toBeInTheDocument();
  });
});
