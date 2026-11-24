import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Account } from '@/types/account';
import { useBillsOutlook } from './useBillsOutlook';

const makeScheduled = (overrides: Partial<ScheduledTransaction> = {}) =>
  ({
    id: 'st-1',
    name: 'Buy index fund',
    amount: -500,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-25',
    isActive: true,
    isTransfer: false,
    transferAccountId: null,
    isSplit: false,
    splits: [],
    endDate: null,
    occurrencesRemaining: null,
    nextOverride: null,
    accountId: 'brokerage',
    account: { id: 'brokerage', name: 'Brokerage' },
    isInvestment: false,
    investmentFundingAccountId: null,
    ...overrides,
  }) as unknown as ScheduledTransaction;

const accounts = [
  { id: 'brokerage', name: 'Brokerage', linkedAccountId: 'brokerage-cash' },
  { id: 'brokerage-cash', name: 'Brokerage Cash' },
  { id: 'chequing', name: 'Chequing' },
] as unknown as Account[];

describe('useBillsOutlook', () => {
  it('names the account a scheduled investment settles in, not the brokerage', () => {
    const st = makeScheduled({ isInvestment: true, investmentFundingAccountId: 'chequing' });
    const { result } = renderHook(() => useBillsOutlook([st], accounts, '2026-11-23'));
    expect(result.current.next?.account).toBe('Chequing');
  });

  it("falls back to the brokerage's linked cash account", () => {
    const st = makeScheduled({ isInvestment: true });
    const { result } = renderHook(() => useBillsOutlook([st], accounts, '2026-11-23'));
    expect(result.current.next?.account).toBe('Brokerage Cash');
  });

  it("names an ordinary schedule's own account, even before the accounts load", () => {
    const st = makeScheduled({ name: 'Rent' });
    const { result } = renderHook(() => useBillsOutlook([st], [], '2026-11-23'));
    expect(result.current.next?.account).toBe('Brokerage');
  });
});
