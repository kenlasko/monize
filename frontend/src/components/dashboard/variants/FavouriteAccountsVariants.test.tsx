import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { FavouriteAccountsFolio } from './FavouriteAccountsFolio';
import { FavouriteAccountsPebble } from './FavouriteAccountsPebble';
import type { FavouriteAccountRow, FavouriteAccountsViewProps } from './favourite-accounts-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/dashboard' }));

const row = (over: Partial<FavouriteAccountRow>): FavouriteAccountRow => ({
  id: 'visa',
  name: 'Visa Rewards',
  institution: 'TD Canada Trust',
  value: { known: true, amount: -637.54, currencyCode: 'USD', foreign: false, text: '-$637.54', breakdown: null },
  statementDueDay: 15,
  statementSettlementDay: 25,
  open: vi.fn(),
  ...over,
});

const props = (over: Partial<FavouriteAccountsViewProps> = {}): FavouriteAccountsViewProps => ({
  rows: [
    row({}),
    row({ id: 'brk', name: 'Brokerage', institution: null, value: { known: false }, statementDueDay: null }),
    row({
      id: 'eur',
      name: 'Euro Savings',
      institution: 'N26',
      value: { known: true, amount: 100, currencyCode: 'EUR', foreign: true, text: '€100.00 EUR', breakdown: null },
      statementDueDay: null,
    }),
  ],
  reordering: false,
  onToggleReorder: vi.fn(),
  onMove: vi.fn(),
  drag: { dragIndex: null, rowProps: () => ({}) as never, dropIndicator: () => null },
  ...over,
});

describe.each([
  ['Folio', FavouriteAccountsFolio],
  ['Pebble', FavouriteAccountsPebble],
])('FavouriteAccounts%s', (_name, Variant) => {
  it('draws each account as one button that opens it, with its institution and due day', () => {
    const p = props();
    render(<Variant {...p} />);
    const visa = screen.getByRole('button', { name: /Visa Rewards/ });
    expect(visa).toHaveTextContent('TD Canada Trust · due 15th');
    expect(visa).toHaveTextContent('-$637.54');
    fireEvent.click(visa);
    expect(p.rows[0].open).toHaveBeenCalled();
  });

  it('says a holdings value it cannot work out is unknown, and names a foreign currency', () => {
    render(<Variant {...props()} />);
    expect(screen.getByRole('button', { name: /Brokerage/ })).not.toHaveTextContent('$');
    expect(screen.getByRole('button', { name: /Euro Savings/ })).toHaveTextContent('€100.00 EUR');
  });

  it('switches to the Standard tiles, with their arrows, while reordering', () => {
    const onToggleReorder = vi.fn();
    const { rerender } = render(<Variant {...props({ onToggleReorder })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    expect(onToggleReorder).toHaveBeenCalled();
    rerender(<Variant {...props({ reordering: true })} />);
    expect(screen.getAllByTitle('Move up')).toHaveLength(3);
  });
});
