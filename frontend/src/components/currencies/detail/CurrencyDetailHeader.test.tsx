import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { act, render } from '@/test/render';
import { stubCollapsingTitle } from '@/test/collapsing-title';
import { CurrencyDetailHeader } from './CurrencyDetailHeader';
import type { CurrencyInfo } from '@/lib/exchange-rates';

// One router object, as the real hook returns, whose `push` this file asserts on.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

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

const usd = currency('USD', 'US Dollar');
const all = [currency('CAD', 'Canadian Dollar'), usd, currency('DEM', 'Deutsche Mark', false)];

function renderHeader(shown: CurrencyInfo = usd) {
  render(
    <CurrencyDetailHeader
      currency={shown}
      defaultCurrency="CAD"
      onBack={vi.fn()}
      currencies={all}
    />,
  );
}

describe('CurrencyDetailHeader', () => {
  it('titles the page with the code and name', () => {
    renderHeader();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('USD');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('US Dollar');
  });

  it('hands the app header "Currencies" with the currency and the same caret, active currencies only', () => {
    const title = stubCollapsingTitle();
    try {
      renderHeader();
      title.collapse();
      const heading = screen.getByRole('heading', { level: 1 }).textContent;
      expect(title.current()).toMatchObject({
        title: 'Currencies',
        context: heading,
        switcher: { currentId: 'USD' },
      });
      expect(title.current()?.switcher?.items.map((item) => item.id)).toEqual([
        'CAD',
        'USD',
      ]);
      act(() => title.current()?.switcher?.onSelect('CAD'));
      expect(router.push).toHaveBeenCalledWith('/currencies/CAD');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
