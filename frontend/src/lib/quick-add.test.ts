import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { quickAddApi } from './quick-add';
import type { QuickAddAccountRef, QuickAddCategoryRef, QuickAddInterpretation } from '@/types/quick-add';

vi.mock('./api', () => ({ default: { post: vi.fn() } }));

const field = <T,>(value: T | null) => ({ value, source: 'typed' as const, ambiguous: false, alternatives: [] as T[] });

function wireReading(): QuickAddInterpretation {
  return {
    kind: field('payment'),
    // NUMERIC crosses the wire as a decimal string.
    amount: { ...field('84.3700' as unknown as number), alternatives: ['12.5000' as unknown as number] },
    date: field('2026-11-20'),
    account: field({ id: 'a1', name: 'Chequing', currencyCode: 'USD' }),
    toAccount: field<QuickAddAccountRef>(null),
    payee: field({ id: 'p1', name: 'Loblaws' }),
    category: field<QuickAddCategoryRef>(null),
    memo: null,
    blockers: [],
    balance: {
      accountId: 'a1',
      currencyCode: 'USD',
      current: '1200.0000' as unknown as number,
      after: '1115.6300' as unknown as number,
      movesOn: null,
    },
    foreignAmount: null,
  };
}

describe('quickAddApi.interpret', () => {
  beforeEach(() => {
    vi.mocked(apiClient.post).mockReset();
  });

  it('posts the line in the body, never the query string', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: wireReading() });
    await quickAddApi.interpret({ text: '84.37 loblaws', today: '2026-11-20' });
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/quick-add/interpret', {
      text: '84.37 loblaws',
      today: '2026-11-20',
    });
  });

  it('reads the money as numbers whatever the wire carried', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: wireReading() });
    const reading = await quickAddApi.interpret({ text: '84.37 loblaws', today: '2026-11-20' });
    expect(reading.amount.value).toBe(84.37);
    expect(reading.amount.alternatives).toEqual([12.5]);
    expect(reading.balance).toMatchObject({ current: 1200, after: 1115.63 });
  });

  it('reads a figure typed in another currency as a number, and its absence as none', async () => {
    const raw = wireReading();
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      data: {
        ...raw,
        blockers: ['foreignCurrency'],
        foreignAmount: { currencyCode: 'EUR', amount: '20.0000' as unknown as number },
      },
    });
    const foreign = await quickAddApi.interpret({ text: '20 € cafe', today: '2026-11-20' });
    expect(foreign.foreignAmount).toEqual({ currencyCode: 'EUR', amount: 20 });

    // An older answer without the field at all.
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { ...raw, foreignAmount: undefined } });
    const plain = await quickAddApi.interpret({ text: '84.37 loblaws', today: '2026-11-20' });
    expect(plain.foreignAmount).toBeNull();
  });

  it('keeps an unknown amount and a deferred balance unknown', async () => {
    const raw = wireReading();
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        ...raw,
        amount: field<number>(null),
        balance: { ...raw.balance!, after: null, movesOn: '2026-12-01' },
      },
    });
    const reading = await quickAddApi.interpret({ text: 'loblaws', today: '2026-11-20' });
    expect(reading.amount.value).toBeNull();
    expect(reading.balance?.after).toBeNull();
  });

  it('lets a failed request fail', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('boom'));
    await expect(quickAddApi.interpret({ text: 'x', today: '2026-11-20' })).rejects.toThrow('boom');
  });
});
