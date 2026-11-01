import { describe, it, expect } from 'vitest';
import { BILLS_CSV_HEADERS, buildBillsCsvRows } from './bills-export';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

function schedule(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    name: 'Rent',
    payeeId: null,
    payee: null,
    payeeName: 'Landlord',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Chequing' },
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Housing' },
    amount: -1200,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-02-15',
    isActive: true,
    autoPost: false,
    isSplit: false,
    isTransfer: false,
    transferAccountId: null,
    transferAccount: null,
    isInvestment: false,
    investmentAction: null,
    investmentSecurityId: null,
    investmentSecurity: null,
    nextOverride: null,
    ...overrides,
  } as unknown as ScheduledTransaction;
}

const column = (name: string) => BILLS_CSV_HEADERS.indexOf(name);

describe('buildBillsCsvRows', () => {
  it('writes one row per schedule under the headers', () => {
    const [row] = buildBillsCsvRows([schedule()]);
    expect(row).toHaveLength(BILLS_CSV_HEADERS.length);
    expect(row).toEqual([
      'Rent',
      'Landlord',
      'Chequing',
      'Housing',
      -1200,
      'CAD',
      'MONTHLY',
      '2026-02-15',
      'No',
      'Yes',
    ]);
  });

  it('writes the next occurrence an override moved and re-priced, not the template', () => {
    const [row] = buildBillsCsvRows([
      schedule({
        nextOverride: {
          id: 'ov-1',
          overrideDate: '2026-02-17',
          amount: -1250,
        } as ScheduledTransaction['nextOverride'],
      }),
    ]);
    expect(row[column('Amount')]).toBe(-1250);
    expect(row[column('Next Due Date')]).toBe('2026-02-17');
  });

  it('coerces the decimal string the API sends into a number', () => {
    const [row] = buildBillsCsvRows([schedule({ amount: '-67.9900' as unknown as number })]);
    expect(row[column('Amount')]).toBe(-67.99);
  });

  it('leaves an amount the server could not price empty rather than zero', () => {
    const [row] = buildBillsCsvRows([schedule({ effectiveAmount: null } as Partial<ScheduledTransaction>)]);
    expect(row[column('Amount')]).toBeNull();
  });

  it('names a transfer by its destination', () => {
    const [row] = buildBillsCsvRows([
      schedule({
        isTransfer: true,
        categoryId: null,
        category: null,
        transferAccount: { id: 'acc-2', name: 'Savings' } as ScheduledTransaction['transferAccount'],
      }),
    ]);
    expect(row[column('Category')]).toBe('Transfer To Savings');
  });

  it('lists every split line', () => {
    const [row] = buildBillsCsvRows([
      schedule({
        isSplit: true,
        categoryId: null,
        category: null,
        splits: [
          { category: { name: 'Groceries' }, transferAccount: null, amount: -40 },
          { category: null, transferAccount: null, amount: -10 },
          { category: null, transferAccount: { name: 'Savings' }, amount: -50 },
        ] as unknown as ScheduledTransaction['splits'],
      }),
    ]);
    expect(row[column('Category')]).toBe('Groceries; Uncategorized; Transfer To Savings');
  });

  it('names an investment by its action and symbol', () => {
    const [row] = buildBillsCsvRows([
      schedule({
        isInvestment: true,
        investmentAction: 'BUY',
        investmentSecurity: { symbol: 'VFV' } as ScheduledTransaction['investmentSecurity'],
      }),
    ]);
    expect(row[column('Category')]).toBe('BUY: VFV');
  });

  it('marks auto-post and inactive schedules', () => {
    const [row] = buildBillsCsvRows([schedule({ autoPost: true, isActive: false })]);
    expect(row[column('Auto-Post')]).toBe('Yes');
    expect(row[column('Active')]).toBe('No');
  });
});
