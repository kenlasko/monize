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

function Harness({
  currencyCode,
  initial,
  transactionAmount = -0.0076,
}: {
  currencyCode: string;
  initial: SplitRow[];
  transactionAmount?: number;
}) {
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
      transactionAmount={transactionAmount}
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

  it('stores a line typed as -0.00002500 at its eight places, not cents', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(
      <Harness
        currencyCode="BTC"
        transactionAmount={-0.005025}
        initial={[line('a', 'cat-1', -0.005), line('b', 'cat-2', -0.00001)]}
      />,
    );
    // The editor renders a desktop and a phone layout; either input edits the line.
    const input = screen.getAllByDisplayValue('-0.00001000')[0];
    fireEvent.change(input, { target: { value: '-0.00002500' } });
    fireEvent.blur(input);
    const stored = onChangeSpy.mock.calls.at(-1)?.[0] as SplitRow[];
    expect(stored[1].amount).toBe(-0.000025);
    expect(screen.getAllByText('Balanced').length).toBeGreaterThan(0);
  });

  it('balances -0.00502500 against a -0.00500000 transfer and a -0.00002500 fee', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(
      <Harness
        currencyCode="BTC"
        transactionAmount={-0.005025}
        initial={[line('a', 'cat-1', -0.005), line('b', 'cat-2', -0.000025)]}
      />,
    );
    expect(screen.getAllByText('Balanced').length).toBeGreaterThan(0);
    const addRemaining = screen.getAllByTitle('No unassigned amount') as HTMLButtonElement[];
    addRemaining.forEach((button) => expect(button.disabled).toBe(true));
  });

  it('shows a one-satoshi remainder and lets "Add remaining" assign it exactly', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(
      <Harness
        currencyCode="BTC"
        transactionAmount={-0.005025}
        initial={[line('a', 'cat-1', -0.005), line('b', 'cat-2', -0.00002499)]}
      />,
    );
    // At four places both sides read -0.0050: "Balanced", every button off,
    // and a save the server refuses.
    expect(screen.queryAllByText('Balanced')).toHaveLength(0);
    expect(screen.getAllByText(/Remaining:/).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'Distribute Proportionally' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const addRemaining = screen.getAllByTitle('Add remaining to this split') as HTMLButtonElement[];
    expect(addRemaining.length).toBeGreaterThan(0);
    addRemaining.forEach((button) => expect(button.disabled).toBe(false));

    fireEvent.click(addRemaining[1]);
    const stored = onChangeSpy.mock.calls.at(-1)?.[0] as SplitRow[];
    expect(stored[1].amount).toBe(-0.000025);
    expect(screen.getAllByText('Balanced').length).toBeGreaterThan(0);
  });

  it('shows a 0.0049 BTC remainder and lets "Add remaining" assign it exactly', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(
      <Harness
        currencyCode="BTC"
        initial={[line('a', 'cat-1', 0), line('b', 'cat-2', -0.0027)]}
      />,
    );
    // Under a one-cent tolerance this read "Balanced" and every button was off.
    expect(screen.queryAllByText('Balanced')).toHaveLength(0);
    const addRemaining = screen.getAllByTitle('Add remaining to this split') as HTMLButtonElement[];
    fireEvent.click(addRemaining[0]);
    const stored = onChangeSpy.mock.calls.at(-1)?.[0] as SplitRow[];
    expect(stored[0].amount).toBe(-0.0049);
    expect(screen.getAllByText('Balanced').length).toBeGreaterThan(0);
  });

  it('distributes a coin total evenly at eight places, the last line taking the remainder', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(
      <Harness
        currencyCode="BTC"
        transactionAmount={-0.00000010}
        initial={[line('a', 'cat-1', 0), line('b', 'cat-2', 0), line('c', 'cat-1', 0)]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Distribute Evenly' }));
    const stored = onChangeSpy.mock.calls.at(-1)?.[0] as SplitRow[];
    expect(stored.map((s) => s.amount)).toEqual([-0.00000003, -0.00000003, -0.00000004]);
  });

  it.each([
    ['0.1 + 0.2 against 0.3', 0.3, [0.1, 0.2]],
    ['33.33 + 33.33 + 33.34 against 100', 100, [33.33, 33.33, 33.34]],
  ])('reads a CAD split whose float sum is off only by noise (%s) as balanced', (_label, total, amounts) => {
    render(
      <Harness
        currencyCode="CAD"
        transactionAmount={total}
        initial={amounts.map((amount, i) => line(`l${i}`, i % 2 ? 'cat-2' : 'cat-1', amount))}
      />,
    );
    expect(screen.getAllByText('Balanced').length).toBeGreaterThan(0);
    const addRemaining = screen.getAllByTitle('No unassigned amount') as HTMLButtonElement[];
    addRemaining.forEach((button) => expect(button.disabled).toBe(true));
  });
});
