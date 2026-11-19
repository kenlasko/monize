import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import { usePayeeSwitcher } from './PayeeSwitcher';
import type { Payee } from '@/types/payee';

// One router object, as the real hook returns: the switcher is memoized on it.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The caret exactly as the detail header draws it. */
function PayeeSwitcher({
  currentId,
  payees,
}: {
  currentId: string;
  payees: Payee[];
}) {
  return <EntitySwitcher {...usePayeeSwitcher(currentId, payees)} />;
}

function payee(id: string, name: string): Payee {
  return {
    id,
    userId: 'user-1',
    name,
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    website: null,
    hasLogo: false,
    logoFetchedAt: null,
    contactLookupAt: null,
    contactLookupSource: null,
    address: null,
    email: null,
    phone: null,
    isActive: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

/** More than the filter threshold of 8, so the box appears. */
function manyPayees(count: number): Payee[] {
  return Array.from({ length: count }, (_, index) =>
    payee(`payee-${index}`, `Payee number ${index}`),
  );
}

const two = [payee('payee-1', 'Starbucks'), payee('payee-2', 'Tim Hortons')];

function open(payees: Payee[], currentId = 'payee-1') {
  const onSelect = router.push;
  onSelect.mockClear();
  render(<PayeeSwitcher currentId={currentId} payees={payees} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch payee' }));
  return { onSelect };
}

describe('PayeeSwitcher', () => {
  it('renders nothing when there is no other payee to switch to', () => {
    render(
      <PayeeSwitcher currentId="payee-1" payees={[two[0]]} />,
    );
    expect(screen.queryByRole('button', { name: 'Switch payee' })).toBeNull();
  });

  it('lists the other payees, not the current one', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Tim Hortons/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Starbucks/ })).toBeNull();
  });

  it('leaves inactive payees out of the menu', () => {
    open([...two, { ...payee('payee-3', 'Old Gym'), isActive: false }]);
    expect(screen.getByRole('menuitem', { name: /Tim Hortons/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Old Gym/ })).toBeNull();
  });

  it('still offers the active payees from an inactive payee\'s page', () => {
    open([{ ...two[0], isActive: false }, two[1]]);
    expect(screen.getByRole('menuitem', { name: /Tim Hortons/ })).toBeInTheDocument();
  });

  it('selects a payee and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /Tim Hortons/ }));
    expect(onSelect).toHaveBeenCalledWith('/payees/payee-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the filter for a short list', () => {
    open(two);
    expect(screen.queryByPlaceholderText('Filter payees...')).toBeNull();
  });

  it('filters a long list by name', () => {
    open(manyPayees(12), 'payee-0');
    const filter = screen.getByPlaceholderText('Filter payees...');
    fireEvent.change(filter, { target: { value: 'number 7' } });
    expect(screen.getByRole('menuitem', { name: /Payee number 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Payee number 3/ })).toBeNull();
  });

  it('says when nothing matches the filter', () => {
    open(manyPayees(12), 'payee-0');
    fireEvent.change(screen.getByPlaceholderText('Filter payees...'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No payees match')).toBeInTheDocument();
  });
});
