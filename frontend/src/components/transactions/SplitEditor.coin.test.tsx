import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@/test/render';
import { SplitEditor, SplitRow } from './SplitEditor';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import type { Account } from '@/types/account';

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: { getRateForDate: vi.fn().mockResolvedValue(null) },
}));

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const accounts = [
  { id: 'wallet', name: 'Bitcoin Wallet', isClosed: false, accountSubType: null, currencyCode: 'BTC' },
] as unknown as Account[];

const categories = [
  { id: 'cat-1', name: 'Fees', parentId: null, isIncome: false },
  { id: 'cat-2', name: 'Purchases', parentId: null, isIncome: false },
] as never[];

const onChangeSpy = vi.fn();

function Harness({ currencyCode, initial }: { currencyCode: string; initial: SplitRow[] }) {
  const [splits, setSplits] = useState(initial);
  return (
    <SplitEditor
      splits={splits}
      onChange={(next) => {
        onChangeSpy(next);
        setSplits(next);
      }}
      categories={categories}
      accounts={accounts}
      sourceAccountId="wallet"
      transactionAmount={-0.0076}
      currencyCode={currencyCode}
      transactionDate="2026-10-29"
    />
  );
}

const line = (id: string, categoryId: string, amount: number): SplitRow => ({
  id,
  splitType: 'category',
  categoryId,
  transferAccountId: undefined,
  amount,
  memo: '',
});

describe('SplitEditor -- a coin account', () => {
  afterEach(() => {
    act(() => clearCurrencyDecimals());
    onChangeSpy.mockClear();
  });

  it('stores a line typed as -0.0051 at its four places, not cents', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    render(
      <Harness
        currencyCode="BTC"
        initial={[line('a', 'cat-1', -0.0025), line('b', 'cat-2', -0.0051)]}
      />,
    );
    // The editor renders a desktop and a phone layout; either input edits the line.
    const input = screen.getAllByDisplayValue('-0.0025')[0];
    fireEvent.change(input, { target: { value: '-0.0051' } });
    fireEvent.blur(input);
    const stored = onChangeSpy.mock.calls.at(-1)?.[0] as SplitRow[];
    expect(stored[0].amount).toBe(-0.0051);
  });
});
