import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopGroupsPanel } from './TopGroupsPanel';
import type { GroupedTotal } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});
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

  it('colours outflows with the theme accent and inflows with the income token', () => {
    const { container } = render(
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
    // Salary (+3000) ranks first and reads as income; Rent (-1200) takes the
    // theme accent rather than red.
    expect(items[0].innerHTML).toContain('var(--chart-income)');
    expect(items[1].innerHTML).toContain('var(--chart-primary)');
    // Guard against both mistakes this panel has made: hardcoded Tailwind
    // shades ignore the active colour theme, and red belongs to the Monthly
    // Totals chart rather than to a routine breakdown.
    expect(container.innerHTML).not.toMatch(/(text|bg)-(red|green)-\d/);
    expect(container.innerHTML).not.toContain('var(--chart-expense)');
  });

  // docs/specs/transfer-categories.md section 9: a Transfer category's group
  // is labelled a transfer and never coloured as income.
  it('labels a Transfer category group a transfer', () => {
    render(
      <TopGroupsPanel
        title="Top Categories"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={[
          { id: 'c3', name: 'Reserve draws', currencyCode: 'CAD', total: 400, count: 1, categoryType: 'transfer' },
          ...totals,
        ]}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    const items = screen.getAllByRole('listitem');
    const draws = items.find((item) => item.textContent?.includes('Reserve draws'))!;
    expect(draws).toHaveTextContent('Transfer');
    expect(draws.innerHTML).toContain('var(--chart-primary)');
    expect(items.find((item) => item.textContent?.includes('Rent'))).not.toHaveTextContent('Transfer');
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

  it('shows the timeframe subtitle when provided', () => {
    render(
      <TopGroupsPanel
        title="Top Categories"
        subtitle="This month"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('This month')).toBeInTheDocument();
  });

  it('renders a header action beside the title when given one', () => {
    render(
      <TopGroupsPanel
        title="Top Categories"
        emptyLabel="No activity"
        fallbackLabel="Uncategorised"
        totals={totals}
        currencyCode="CAD"
        isLoading={false}
        headerAction={<button type="button">All time</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument();
  });

  it('renders no action container when none is given', () => {
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
    expect(screen.getByText('Top Categories')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All time' })).toBeNull();
  });

  it('marks a row that includes an estimated amount, and only that row', () => {
    render(
      <TopGroupsPanel
        title="Accounts"
        emptyLabel="No activity"
        fallbackLabel="Unknown"
        totals={[
          { id: 'a1', name: 'EUR Savings', currencyCode: 'CAD', total: 80, count: 1, provisionalCount: 1 },
          { id: 'a2', name: 'Chequing', currencyCode: 'CAD', total: -50, count: 1, provisionalCount: 0 },
          { id: 'a3', name: 'Visa', currencyCode: 'CAD', total: -40, count: 1 },
        ]}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('EUR Savings');
    expect(items[0].querySelector('[data-testid="provisional-mark"]')).not.toBeNull();
    expect(screen.getAllByTestId('provisional-mark')).toHaveLength(1);
  });

  it('keeps the mark outside a clickable row, so no button sits inside another', () => {
    render(
      <TopGroupsPanel
        title="Accounts"
        emptyLabel="No activity"
        fallbackLabel="Unknown"
        totals={[{ id: 'a1', name: 'EUR Savings', currencyCode: 'CAD', total: 80, count: 1, provisionalCount: 1 }]}
        currencyCode="CAD"
        isLoading={false}
        onSelect={vi.fn()}
      />,
    );
    const mark = screen.getByTestId('provisional-mark');
    expect(mark.closest('button[type="button"]')).not.toBe(screen.getByText('EUR Savings').closest('button'));
    expect(screen.getByText('EUR Savings').closest('button')?.querySelector('button')).toBeNull();
  });
});
