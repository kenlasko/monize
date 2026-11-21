import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { BillsOutlookFolio } from './BillsOutlookFolio';
import { BillsOutlookPebble } from './BillsOutlookPebble';
import type { BillsOutlookProps } from './bills-outlook-view';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

const days = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-11-${String(20 + i).padStart(2, '0')}`,
  isToday: i === 0,
  items: [] as BillsOutlookProps['strip']['days'][number]['items'],
}));
days[3].items = [{ id: 'a', name: 'Hydro', kind: 'bill', payee: 'Hydro One', magnitude: 120, currencyCode: 'USD' }];

const transaction = { id: 'a', name: 'Hydro' } as ScheduledTransaction;

const props = (over: Partial<BillsOutlookProps> = {}): BillsOutlookProps => ({
  strip: { days, scaleMax: 120 },
  next: {
    transaction,
    name: 'Hydro',
    payee: 'Hydro One',
    account: 'Chequing',
    dueDate: '2026-11-23',
    amount: -120,
    currencyCode: 'USD',
    kind: 'bill',
  },
  onPost: vi.fn(),
  ...over,
});

describe('BillsOutlookFolio', () => {
  it('prints the fourteen-day strip under its section title', () => {
    render(<BillsOutlookFolio {...props()} />);
    expect(screen.getByRole('heading', { name: 'Next fourteen days' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /next fourteen days/ })).toBeInTheDocument();
  });

  it("opens a day's bills and deposits when its column is clicked", () => {
    render(<BillsOutlookFolio {...props()} />);
    const columns = screen.getByRole('group', { name: /next fourteen days/ }).querySelectorAll('button');
    expect(columns).toHaveLength(14);
    fireEvent.click(columns[3]);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Hydro')).toBeInTheDocument();
    expect(dialog.getByText('Hydro One · Bill')).toBeInTheDocument();
    expect(dialog.getByText('-$120.00')).toBeInTheDocument();
  });
});

describe('BillsOutlookPebble', () => {
  it('shows the next occurrence and posts it from the pill', () => {
    const p = props();
    render(<BillsOutlookPebble {...p} />);
    expect(screen.getByText('Hydro')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
    fireEvent.click(screen.getByRole('button', { name: /post/i }));
    expect(p.onPost).toHaveBeenCalledWith(transaction);
  });

  it('shows the occurrence behind a dot on hover', () => {
    render(<BillsOutlookPebble {...props()} />);
    const dot = screen.getByRole('button', { name: 'Hydro · Hydro One · Bill · -$120.00' });
    fireEvent.pointerEnter(dot, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hydro · Hydro One · Bill · -$120.00');
  });

  it('draws only the day chips when nothing is ahead', () => {
    render(<BillsOutlookPebble {...props({ next: null })} />);
    expect(screen.queryByRole('button', { name: /post/i })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
  });

  it("opens a day's bills and deposits when its date is clicked", () => {
    render(<BillsOutlookPebble {...props()} />);
    const chips = screen.getAllByRole('listitem');
    fireEvent.click(chips[3].querySelector('button')!);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Hydro')).toBeInTheDocument();
    expect(dialog.getByText('Hydro One · Bill')).toBeInTheDocument();
    expect(dialog.getByText('-$120.00')).toBeInTheDocument();
  });
});
