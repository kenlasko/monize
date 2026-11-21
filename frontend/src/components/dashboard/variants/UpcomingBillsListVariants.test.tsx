import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { UpcomingBillsListFolio } from './UpcomingBillsListFolio';
import { UpcomingBillsListPebble } from './UpcomingBillsListPebble';
import type { UpcomingBillRow, UpcomingBillsListProps } from './upcoming-bills-view';

const row = (over: Partial<UpcomingBillRow>): UpcomingBillRow => ({
  id: 'a',
  name: 'Hydro Bill',
  payee: 'Hydro One',
  dueDate: '2026-11-21',
  overdue: false,
  dueLabel: 'Tomorrow',
  dueClass: '',
  kind: 'bill',
  typeBadge: null,
  amountText: '-$120.00',
  amountClass: 'text-red-600',
  manual: true,
  estimated: false,
  overdraws: false,
  ...over,
});

const days = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-11-${String(20 + i).padStart(2, '0')}`.replace('2026-11-31', '2026-12-01'),
  isToday: i === 0,
  items: [] as UpcomingBillsListProps['strip']['days'][number]['items'],
}));
days[1].items = [{ id: 'a', name: 'Hydro Bill', kind: 'bill', magnitude: 120 }];
days[2].items = [{ id: 'b', name: 'Salary', kind: 'deposit', magnitude: 2250 }];

const base = (onOpen = vi.fn(), onShowAll = vi.fn()): UpcomingBillsListProps => ({
  rows: [
    row({}),
    row({ id: 'b', name: 'Salary', payee: null, kind: 'deposit', amountText: '+$2,250.00', manual: false, dueDate: '2026-11-22' }),
    row({ id: 'c', name: 'Gift', payee: null, kind: 'transfer', amountText: null, manual: false, dueDate: '2026-11-22', overdraws: true }),
  ],
  hiddenCount: 7,
  strip: { days, scaleMax: 2250 },
  onOpen,
  onShowAll,
});

describe.each([
  ['Folio', UpcomingBillsListFolio],
  ['Pebble', UpcomingBillsListPebble],
])('UpcomingBillsList%s', (_name, Variant) => {
  it('lists every occurrence as a button that posts it, an unknown amount said as one', () => {
    const onOpen = vi.fn();
    render(<Variant {...base(onOpen)} />);
    const buttons = screen.getAllByRole('button', { name: /Hydro Bill|Salary|Gift/ });
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveTextContent('Hydro One');
    expect(buttons[0]).toHaveTextContent('-$120.00');
    fireEvent.click(buttons[1]);
    expect(onOpen).toHaveBeenCalledWith('b');
    expect(buttons[2]).not.toHaveTextContent('$');
  });

  it('marks an occurrence that overdraws its account, with the legend', () => {
    render(<Variant {...base()} />);
    expect(screen.getByRole('img', { name: /below zero/ })).toBeInTheDocument();
    expect(screen.getByText('Takes its account below zero')).toBeInTheDocument();
  });

  it('offers the occurrences beyond the list', () => {
    const onShowAll = vi.fn();
    render(<Variant {...base(vi.fn(), onShowAll)} />);
    fireEvent.click(screen.getByRole('button', { name: '+7 more' }));
    expect(onShowAll).toHaveBeenCalled();
  });

  it('draws the two weeks under one accessible name', () => {
    render(<Variant {...base()} />);
    expect(screen.getByLabelText(/The next two weeks/)).toBeInTheDocument();
  });
});

describe('UpcomingBillsListFolio', () => {
  it('prints a day once, at the head of its occurrences', () => {
    render(<UpcomingBillsListFolio {...base()} />);
    const items = screen.getAllByRole('listitem');
    expect(items[1].querySelector('span')?.textContent).not.toBe('');
    expect(items[2].querySelector('span')?.textContent).toBe('');
  });
});

describe('UpcomingBillsListPebble', () => {
  it('marks today among the fourteen day chips', () => {
    render(<UpcomingBillsListPebble {...base()} />);
    const chips = screen.getByLabelText(/The next two weeks/).querySelectorAll('li');
    expect(chips).toHaveLength(14);
    expect(chips[0]).toHaveAttribute('aria-current', 'date');
  });
});
