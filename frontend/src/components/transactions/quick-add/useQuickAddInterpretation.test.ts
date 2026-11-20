import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import { qaPaymentReading, qaField } from '@/test/quick-add-fixtures';
import type { QuickAddInterpretation, QuickAddPins } from '@/types/quick-add';
import { QUICK_ADD_DEBOUNCE_MS, useQuickAddInterpretation, type QuickAddReadingInput } from './useQuickAddInterpretation';

const interpret = vi.fn();
vi.mock('@/lib/quick-add', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quick-add')>()),
  quickAddApi: { interpret: (...args: unknown[]) => interpret(...args) },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NO_PINS: QuickAddPins = {};

function renderReading(initial: Partial<QuickAddReadingInput> = {}) {
  return renderHook((props: QuickAddReadingInput) => useQuickAddInterpretation(props), {
    initialProps: { text: '', pins: NO_PINS, today: '2026-11-20', ...initial },
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useQuickAddInterpretation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    interpret.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks nothing while the line is empty', async () => {
    const { result } = renderReading();
    await advance(QUICK_ADD_DEBOUNCE_MS * 2);
    expect(interpret).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('waits for typing to pause, then asks once for the line as it rests', async () => {
    interpret.mockResolvedValue(qaPaymentReading());
    const { rerender, result } = renderReading();
    rerender({ text: '8', pins: NO_PINS, today: '2026-11-20' });
    await advance(50);
    rerender({ text: '84', pins: NO_PINS, today: '2026-11-20' });
    await advance(50);
    rerender({ text: '84.37 loblaws', pins: NO_PINS, today: '2026-11-20' });
    await advance(QUICK_ADD_DEBOUNCE_MS - 1);
    expect(interpret).not.toHaveBeenCalled();
    expect(result.current.status).toBe('pending');
    await advance(1);
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(interpret).toHaveBeenCalledWith({ text: '84.37 loblaws', today: '2026-11-20' });
    expect(result.current.status).toBe('ready');
    expect(result.current.interpretation?.payee.value?.name).toBe('Loblaws');
  });

  it('asks at once for a line it was opened with, with the register account', async () => {
    interpret.mockResolvedValue(qaPaymentReading());
    renderReading({ text: '84.37 loblaws', contextAccountId: 'acc-chq' });
    await advance(0);
    expect(interpret).toHaveBeenCalledWith({
      text: '84.37 loblaws',
      today: '2026-11-20',
      contextAccountId: 'acc-chq',
    });
  });

  it('asks again at once when a pin changes, and sends the pins', async () => {
    interpret.mockResolvedValue(qaPaymentReading());
    const { rerender } = renderReading({ text: '84.37 loblaws' });
    await advance(0);
    expect(interpret).toHaveBeenCalledTimes(1);
    rerender({ text: '84.37 loblaws', pins: { kind: 'deposit' }, today: '2026-11-20' });
    await advance(0);
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(interpret).toHaveBeenLastCalledWith({
      text: '84.37 loblaws',
      today: '2026-11-20',
      pins: { kind: 'deposit' },
    });
  });

  it('drops a slow answer to an earlier line, and keeps the stale one only as stale', async () => {
    const first = deferred<QuickAddInterpretation>();
    const second = deferred<QuickAddInterpretation>();
    interpret.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender, result } = renderReading({ text: '84' });
    await advance(0);
    rerender({ text: '84 tim hortons', pins: NO_PINS, today: '2026-11-20' });
    await advance(QUICK_ADD_DEBOUNCE_MS);
    expect(interpret).toHaveBeenCalledTimes(2);

    const latest = qaPaymentReading({ payee: qaField({ id: 'p-tim', name: 'Tim Hortons' }) });
    await act(async () => second.resolve(latest));
    await act(async () => first.resolve(qaPaymentReading()));
    expect(result.current.status).toBe('ready');
    expect(result.current.interpretation?.payee.value?.name).toBe('Tim Hortons');

    // A newer line is pending: the last reading is shown, and is not actionable.
    rerender({ text: '84 tim hortons coffee', pins: NO_PINS, today: '2026-11-20' });
    expect(result.current.status).toBe('pending');
    expect(result.current.interpretation).toBeNull();
    expect(result.current.shown?.payee.value?.name).toBe('Tim Hortons');
  });

  it('starts a cleared line from nothing: no earlier reading is drawn or reused for it', async () => {
    interpret.mockResolvedValue(qaPaymentReading());
    const { rerender, result } = renderReading({ text: '84.37 loblaws' });
    await advance(0);
    expect(result.current.status).toBe('ready');

    // Save & New clears the line.
    rerender({ text: '', pins: NO_PINS, today: '2026-11-20' });
    expect(result.current.status).toBe('idle');
    expect(result.current.shown).toBeNull();

    // The next line: nothing from the saved entry while its own reading is on the way.
    const next = deferred<QuickAddInterpretation>();
    interpret.mockReturnValueOnce(next.promise);
    rerender({ text: '84.37 loblaws', pins: NO_PINS, today: '2026-11-20' });
    expect(result.current.status).toBe('pending');
    expect(result.current.shown).toBeNull();
    expect(result.current.interpretation).toBeNull();
    await advance(QUICK_ADD_DEBOUNCE_MS);
    expect(interpret).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(qaPaymentReading({ amount: qaField(84.37) })));
    expect(result.current.status).toBe('ready');
  });

  it('reports a failed request as failed, never as an empty reading, and tries again', async () => {
    interpret.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderReading({ text: '84.37 loblaws' });
    await advance(0);
    expect(result.current.status).toBe('failed');
    expect(result.current.interpretation).toBeNull();
    expect(result.current.shown).toBeNull();

    interpret.mockResolvedValueOnce(qaPaymentReading());
    act(() => result.current.retry());
    expect(result.current.status).toBe('pending');
    await advance(0);
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
  });
});
