import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { useState } from 'react';
import { useSplitTransferFxAutofill, SplitFxLine, SplitFxPair } from './useSplitTransferFxAutofill';

const mockGetRateForDate = vi.fn();
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: (...args: unknown[]) => mockGetRateForDate(...args),
  },
}));

const USD: SplitFxPair = { toCurrency: 'USD', fxFeePercent: null };

/** The hook over real state, the way the split editor holds its lines. */
function setup(
  initialLines: SplitFxLine[],
  pairs: Record<string, SplitFxPair>,
  date = '2026-10-29',
) {
  return renderHook(
    ({ txDate }) => {
      const [lines, setLines] = useState<SplitFxLine[]>(initialLines);
      const fx = useSplitTransferFxAutofill<SplitFxLine>({
        fromCurrency: 'CAD',
        date: txDate,
        lines,
        pairOf: (line) => pairs[line.id] ?? null,
        defaultSign: -1,
        onPatch: (patches) =>
          setLines((prev) =>
            prev.map((line) => (patches[line.id] ? { ...line, ...patches[line.id] } : line)),
          ),
      });
      const line = (id: string) => lines.find((l) => l.id === id) as SplitFxLine;
      return {
        line,
        setAmount: (id: string, amount: number) =>
          setLines(fx.reconcile(lines, lines.map((l) => (l.id === id ? { ...l, amount } : l)))),
        typeTarget: (id: string, value: number | undefined) =>
          setLines(lines.map((l) => (l.id === id ? { ...l, ...fx.editTarget(l, value) } : l))),
      };
    },
    { initialProps: { txDate: date } },
  );
}

async function flushRate() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}

describe('useSplitTransferFxAutofill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetRateForDate.mockReset();
    mockGetRateForDate.mockResolvedValue(0.73);
  });

  it('fills a cross-currency line from the rate for the transaction date', async () => {
    const { result } = setup([{ id: 'a', amount: -40 }], { a: USD });
    await flushRate();

    expect(mockGetRateForDate).toHaveBeenCalledWith('CAD', 'USD', '2026-10-29');
    expect(result.current.line('a').transferTargetAmount).toBe(29.2);
    expect(result.current.line('a').amount).toBe(-40);
  });

  it('leaves a line that is not a cross-currency transfer alone', async () => {
    const { result } = setup([{ id: 'a', amount: -40 }], {});
    await flushRate();

    expect(mockGetRateForDate).not.toHaveBeenCalled();
    expect(result.current.line('a').transferTargetAmount).toBeUndefined();
  });

  it('fetches each pair once and fills every line of it', async () => {
    const { result } = setup(
      [
        { id: 'a', amount: -40 },
        { id: 'b', amount: -100 },
        { id: 'c', amount: -10 },
      ],
      { a: USD, b: USD, c: { toCurrency: 'EUR', fxFeePercent: null } },
    );
    await flushRate();

    expect(mockGetRateForDate).toHaveBeenCalledTimes(2);
    expect(result.current.line('a').transferTargetAmount).toBe(29.2);
    expect(result.current.line('b').transferTargetAmount).toBe(73);
    expect(result.current.line('c').transferTargetAmount).toBe(7.3);
  });

  it('takes the converting account fee off what arrives', async () => {
    const { result } = setup([{ id: 'a', amount: -100 }], {
      a: { toCurrency: 'USD', fxFeePercent: 2.5 },
    });
    await flushRate();

    // 73.00 at the market rate, less a 2.5% fee of 1.83.
    expect(result.current.line('a').transferTargetAmount).toBe(71.17);
  });

  it('re-derives a filled received amount when the line amount moves', async () => {
    const { result } = setup([{ id: 'a', amount: -40 }], { a: USD });
    await flushRate();

    act(() => result.current.setAmount('a', -100));
    expect(result.current.line('a').transferTargetAmount).toBe(73);
  });

  it('never re-prices a received amount the user typed', async () => {
    const { result } = setup([{ id: 'a', amount: -100 }], { a: USD });
    await flushRate();
    expect(result.current.line('a').transferTargetAmount).toBe(73);

    // The bank's fee: the user corrects the received figure.
    act(() => result.current.typeTarget('a', 72.5));
    expect(result.current.line('a').amount).toBe(-100);
    act(() => result.current.setAmount('a', -110));
    expect(result.current.line('a').transferTargetAmount).toBe(72.5);
  });

  it('derives the amount from a typed received amount on an empty line, with the parent sign', async () => {
    const { result } = setup([{ id: 'a', amount: 0 }], { a: USD });
    await flushRate();
    expect(result.current.line('a').transferTargetAmount).toBeUndefined();

    act(() => result.current.typeTarget('a', 73));
    expect(result.current.line('a').amount).toBe(-100);
    expect(result.current.line('a').transferTargetAmount).toBe(73);
  });

  it('re-derives an amount it derived when the received amount is retyped', async () => {
    const { result } = setup([{ id: 'a', amount: 0 }], { a: USD });
    await flushRate();
    act(() => result.current.typeTarget('a', 73));
    act(() => result.current.typeTarget('a', 146));

    expect(result.current.line('a').amount).toBe(-200);
  });

  it('stops deriving the amount once the user types it', async () => {
    const { result } = setup([{ id: 'a', amount: 0 }], { a: USD });
    await flushRate();
    act(() => result.current.typeTarget('a', 73));
    act(() => result.current.setAmount('a', 100));
    act(() => result.current.typeTarget('a', 80));

    expect(result.current.line('a').amount).toBe(100);
    expect(result.current.line('a').transferTargetAmount).toBe(80);
  });

  it('leaves both values alone when both are already filled (an edited split)', async () => {
    const { result } = setup(
      [{ id: 'a', amount: -100, transferTargetAmount: 72, transferTargetFromCurrency: 'CAD' }],
      { a: USD },
    );
    await flushRate();

    expect(result.current.line('a').transferTargetAmount).toBe(72);
    act(() => result.current.setAmount('a', -120));
    expect(result.current.line('a').transferTargetAmount).toBe(72);
  });

  it('re-derives a filled received amount when the date changes the rate', async () => {
    const { result, rerender } = setup([{ id: 'a', amount: -100 }], { a: USD });
    await flushRate();
    expect(result.current.line('a').transferTargetAmount).toBe(73);

    mockGetRateForDate.mockResolvedValue(0.75);
    rerender({ txDate: '2026-10-28' });
    await flushRate();

    expect(mockGetRateForDate).toHaveBeenLastCalledWith('CAD', 'USD', '2026-10-28');
    expect(result.current.line('a').transferTargetAmount).toBe(75);
  });

  it('treats a received amount stated against another parent currency as empty', async () => {
    const { result } = setup(
      [{ id: 'a', amount: -100, transferTargetAmount: 72, transferTargetFromCurrency: 'EUR' }],
      { a: USD },
    );
    await flushRate();

    expect(result.current.line('a').transferTargetAmount).toBe(73);
    expect(result.current.line('a').transferTargetFromCurrency).toBe('CAD');
  });

  it('rounds a received amount to the target currency precision', async () => {
    mockGetRateForDate.mockResolvedValue(108.37);
    const { result } = setup([{ id: 'a', amount: -40 }], {
      a: { toCurrency: 'JPY', fxFeePercent: null },
    });
    await flushRate();

    // 4334.80 at cents; a yen amount has no fraction.
    expect(result.current.line('a').transferTargetAmount).toBe(4335);
  });

  it('fills an empty amount from a received amount typed before the rate arrived', async () => {
    const { result } = setup([{ id: 'a', amount: 0 }], { a: USD });
    act(() => result.current.typeTarget('a', 73));
    await flushRate();

    expect(result.current.line('a').amount).toBe(-100);
    expect(result.current.line('a').transferTargetAmount).toBe(73);
  });

  it('fills nothing when no rate is known', async () => {
    mockGetRateForDate.mockResolvedValue(null);
    const { result } = setup([{ id: 'a', amount: -100 }], { a: USD });
    await flushRate();

    expect(result.current.line('a').transferTargetAmount).toBeUndefined();
    act(() => result.current.setAmount('a', -50));
    expect(result.current.line('a').transferTargetAmount).toBeUndefined();
  });

  it('fills nothing when the lookup fails', async () => {
    mockGetRateForDate.mockRejectedValue(new Error('offline'));
    const { result } = setup([{ id: 'a', amount: -100 }], { a: USD });
    await flushRate();

    expect(result.current.line('a').transferTargetAmount).toBeUndefined();
  });
});
