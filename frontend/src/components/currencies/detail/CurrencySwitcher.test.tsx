import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import { useCurrencySwitcher } from './CurrencySwitcher';
import type { CurrencyInfo } from '@/lib/exchange-rates';

// One router object, as the real hook returns: the switcher is memoized on it.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The caret exactly as the detail header draws it. */
function CurrencySwitcher({
  currentCode,
  currencies,
}: {
  currentCode: string;
  currencies: CurrencyInfo[];
}) {
  return <EntitySwitcher {...useCurrencySwitcher(currentCode, currencies)} />;
}

function currency(code: string, name: string, isActive = true): CurrencyInfo {
  return {
    code,
    name,
    symbol: '$',
    decimalPlaces: 2,
    isActive,
    isSystem: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    kind: 'FIAT',
    quoteSymbol: null,
  };
}

const cad = currency('CAD', 'Canadian Dollar');
const usd = currency('USD', 'US Dollar');
const dem = currency('DEM', 'Deutsche Mark', false);

function open(currencies: CurrencyInfo[], currentCode = 'CAD') {
  router.push.mockClear();
  render(<CurrencySwitcher currentCode={currentCode} currencies={currencies} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch currency' }));
}

describe('CurrencySwitcher', () => {
  it('renders nothing when no other active currency exists', () => {
    render(<CurrencySwitcher currentCode="CAD" currencies={[cad, dem]} />);
    expect(screen.queryByRole('button', { name: 'Switch currency' })).toBeNull();
  });

  it('lists the other active currencies, not the current or an inactive one', () => {
    open([cad, usd, dem]);
    expect(screen.getByRole('menuitem', { name: /USD/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /CAD/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /DEM/ })).toBeNull();
  });

  it('still offers the active currencies from an inactive currency\'s page', () => {
    open([cad, usd, dem], 'DEM');
    expect(screen.getByRole('menuitem', { name: /CAD/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /USD/ })).toBeInTheDocument();
  });

  it('navigates to the chosen currency and closes', () => {
    open([cad, usd]);
    fireEvent.click(screen.getByRole('menuitem', { name: /USD/ }));
    expect(router.push).toHaveBeenCalledWith('/currencies/USD');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
