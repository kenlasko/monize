import { describe, it, expect } from 'vitest';
import {
  chipForInvestment,
  chipForOccurrence,
  chipForTransaction,
  dedupeInvestmentLegs,
  groupCalendarRows,
  groupInvestmentCalendarRows,
  groupRowsByDay,
  rowDate,
  type CalendarAccount,
} from './calendar-rows';
import { ACCOUNT_TYPE_META } from './account-type-meta';
import { SCHEDULED_KIND_CHIP_CLASSES } from './scheduled-kind';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { InvestmentTransaction } from '@/types/investment';
import type {
  ScheduledOccurrence,
  ScheduledTransaction,
} from '@/types/scheduled-transaction';

const TODAY = '2026-06-15';

const accountsById = new Map<string, CalendarAccount>([
  ['chequing-1', { id: 'chequing-1', accountType: 'CHEQUING' }],
  ['card-1', { id: 'card-1', accountType: 'CREDIT_CARD' }],
]);

function transaction(): Transaction {
  return {
    id: 'tx-1',
    accountId: 'chequing-1',
    transactionDate: '2026-06-10',
    amount: -25,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
    payeeName: 'Grocer',
  } as Transaction;
}

function withOverrides(base: Partial<Transaction>): Transaction {
  return { ...transaction(), ...base } as Transaction;
}

function occurrence(overrides: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence {
  return {
    scheduledTransactionId: 'st-1',
    originalDate: '2026-06-20',
    dueDate: '2026-06-20',
    amount: -1200,
    amountComplete: true,
    directionAmount: -1200,
    currencyCode: 'CAD',
    overrideId: null,
    moved: false,
    accountId: 'chequing-1',
    transferAccountId: null,
    isTransfer: false,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    name: 'Rent',
    amount: -1200,
    currencyCode: 'CAD',
    accountId: 'chequing-1',
    isTransfer: false,
    ...overrides,
  } as ScheduledTransaction;
}

describe('rowDate', () => {
  it('takes the calendar day out of either shape the server sends', () => {
    expect(rowDate('2026-06-10')).toBe('2026-06-10');
    expect(rowDate('2026-06-10T00:00:00.000Z')).toBe('2026-06-10');
  });
});

describe('groupRowsByDay', () => {
  it('keeps each day the order the rows arrived in', () => {
    const rows = [
      { id: 'a', date: '2026-06-10' },
      { id: 'b', date: '2026-06-11' },
      { id: 'c', date: '2026-06-10' },
    ];

    const grouped = groupRowsByDay(rows, (row) => row.date);

    expect(grouped.get('2026-06-10')?.map((r) => r.id)).toEqual(['a', 'c']);
    expect(grouped.get('2026-06-11')?.map((r) => r.id)).toEqual(['b']);
  });

  it('holds no entry for a day with nothing on it', () => {
    expect(groupRowsByDay([], () => '2026-06-10').size).toBe(0);
  });
});

describe('chipForTransaction', () => {
  it('takes its colour from the account type, the same mapping the account list uses', () => {
    const chip = chipForTransaction(transaction(), accountsById, TODAY);
    expect(chip.className).toBe(ACCOUNT_TYPE_META.CHEQUING.pillClass);

    const card = chipForTransaction(
      withOverrides({ accountId: 'card-1' }),
      accountsById,
      TODAY,
    );
    expect(card.className).toBe(ACCOUNT_TYPE_META.CREDIT_CARD.pillClass);
  });

  it('still draws a row whose account the client does not hold', () => {
    // The row is money that moved; dropping it because the accounts request
    // answered short would take the day's figures with it.
    const chip = chipForTransaction(
      withOverrides({ accountId: 'missing' }),
      accountsById,
      TODAY,
    );
    expect(chip.className).toBe(ACCOUNT_TYPE_META.OTHER.pillClass);
  });

  it('marks a void row without dropping it', () => {
    const chip = chipForTransaction(withOverrides({ status: TransactionStatus.VOID }), accountsById, TODAY);
    expect(chip.isVoid).toBe(true);
  });

  it.each([
    ['2026-06-14', false],
    ['2026-06-15', false],
    ['2026-06-16', true],
  ])('dates %s against the server today', (transactionDate, isFuture) => {
    const chip = chipForTransaction(withOverrides({ transactionDate }), accountsById, TODAY);
    expect(chip.isFuture).toBe(isFuture);
  });
});

describe('chipForOccurrence', () => {
  it('colours a bill, a deposit and a transfer by the occurrence direction', () => {
    expect(chipForOccurrence(occurrence(), schedule(), TODAY).className).toBe(
      SCHEDULED_KIND_CHIP_CLASSES.bill,
    );
    expect(
      chipForOccurrence(
        occurrence({ amount: 2000, directionAmount: 2000 }),
        schedule({ amount: 2000 }),
        TODAY,
      ).className,
    ).toBe(SCHEDULED_KIND_CHIP_CLASSES.deposit);
    expect(
      chipForOccurrence(occurrence(), schedule({ isTransfer: true }), TODAY).className,
    ).toBe(SCHEDULED_KIND_CHIP_CLASSES.transfer);
  });

  it('colours an unpriceable occurrence neutrally rather than guessing a side', () => {
    const chip = chipForOccurrence(
      occurrence({ amount: null, amountComplete: false, directionAmount: null }),
      schedule(),
      TODAY,
    );
    expect(chip.className).toBe(SCHEDULED_KIND_CHIP_CLASSES.unknown);
  });

  it.each([
    ['2026-06-14', true],
    ['2026-06-15', false],
    ['2026-06-16', false],
  ])('marks %s overdue against the server today', (dueDate, isOverdue) => {
    expect(chipForOccurrence(occurrence({ dueDate }), schedule(), TODAY).isOverdue).toBe(
      isOverdue,
    );
  });

  it('keys on the recurrence slot, so two occurrences of one schedule are distinct', () => {
    const first = chipForOccurrence(occurrence({ originalDate: '2026-06-20' }), schedule(), TODAY);
    const second = chipForOccurrence(occurrence({ originalDate: '2026-07-20' }), schedule(), TODAY);
    expect(first.key).not.toBe(second.key);
  });
});

describe('groupCalendarRows', () => {
  const schedulesById = new Map([['st-1', schedule()]]);

  it('reads a day top to bottom as it happened, not newest first', () => {
    // The register answers newest first and its within-day order is total, so a
    // day's slice reversed IS its ascending register order. Arrival order here is
    // the register's: the latest row first.
    const days = groupCalendarRows({
      transactions: [
        withOverrides({ id: 'tx-evening' }),
        withOverrides({ id: 'tx-noon' }),
        withOverrides({ id: 'tx-morning' }),
      ],
      occurrences: [],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-10')?.transactions.map((c) => c.key)).toEqual([
      'tx-morning',
      'tx-noon',
      'tx-evening',
    ]);
  });

  it('leaves the occurrences in the order they arrived, which is already by due date', () => {
    const days = groupCalendarRows({
      transactions: [],
      occurrences: [
        occurrence({ scheduledTransactionId: 'st-1', originalDate: '2026-06-20' }),
        occurrence({ scheduledTransactionId: 'st-1', originalDate: '2026-06-20b' }),
      ],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-20')?.occurrences.map((c) => c.key)).toEqual([
      'st-1:2026-06-20',
      'st-1:2026-06-20b',
    ]);
  });

  it('puts rows and occurrences on their own days', () => {
    const days = groupCalendarRows({
      transactions: [transaction(), withOverrides({ id: 'tx-2', transactionDate: '2026-06-11' })],
      occurrences: [occurrence()],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-10')?.transactions.map((c) => c.key)).toEqual(['tx-1']);
    expect(days.get('2026-06-11')?.transactions.map((c) => c.key)).toEqual(['tx-2']);
    expect(days.get('2026-06-20')?.occurrences).toHaveLength(1);
    expect(days.get('2026-06-20')?.transactions).toEqual([]);
  });

  it('places an occurrence on the day it was moved to', () => {
    const days = groupCalendarRows({
      transactions: [],
      occurrences: [occurrence({ originalDate: '2026-06-20', dueDate: '2026-06-23', moved: true })],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.has('2026-06-20')).toBe(false);
    expect(days.get('2026-06-23')?.occurrences).toHaveLength(1);
  });

  it('drops an occurrence whose schedule the client does not hold', () => {
    // Its chip would have no name to print and no kind to colour.
    const days = groupCalendarRows({
      transactions: [],
      occurrences: [occurrence({ scheduledTransactionId: 'st-missing' })],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.size).toBe(0);
  });

  it('reads a timestamped transaction date as its calendar day', () => {
    const days = groupCalendarRows({
      transactions: [withOverrides({ transactionDate: '2026-06-10T00:00:00.000Z' })],
      occurrences: [],
      schedulesById,
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-10')?.transactions).toHaveLength(1);
  });
});

function brokerageRow(overrides: Partial<InvestmentTransaction> = {}): InvestmentTransaction {
  return {
    id: 'inv-1',
    accountId: 'brokerage-1',
    action: 'BUY',
    transactionDate: '2026-06-10',
    totalAmount: 505,
    status: TransactionStatus.CLEARED,
    security: { id: 'sec-1', symbol: 'ABC', currencyCode: 'USD' },
    ...overrides,
  } as InvestmentTransaction;
}

describe('dedupeInvestmentLegs (I5)', () => {
  it('drops the cash leg of a trade that is itself on screen', () => {
    const cash = withOverrides({
      id: 'cash-leg',
      accountId: 'sleeve-1',
      linkedInvestmentTransactionId: 'inv-1',
    });

    expect(dedupeInvestmentLegs([cash], new Set(['inv-1']))).toEqual([]);
  });

  it('keeps the cash leg when its trade is out of scope', () => {
    // The cash sleeve without its brokerage: this row is the only record of the
    // movement the reader can see, so dropping it would lose the day.
    const cash = withOverrides({
      id: 'cash-leg',
      accountId: 'sleeve-1',
      linkedInvestmentTransactionId: 'inv-1',
    });

    expect(dedupeInvestmentLegs([cash], new Set())).toHaveLength(1);
  });

  it('keeps a cash row that is nobody\'s leg', () => {
    const deposit = withOverrides({ id: 'cash-deposit', accountId: 'sleeve-1', amount: 1000 });

    expect(dedupeInvestmentLegs([deposit], new Set(['inv-1']))).toHaveLength(1);
  });
});

describe('chipForInvestment', () => {
  it('wears the investment pill, whatever account the row sits in', () => {
    expect(chipForInvestment(brokerageRow(), TODAY).className).toBe(
      ACCOUNT_TYPE_META.INVESTMENT.pillClass,
    );
  });

  it('carries the void and future flags rather than dropping the row', () => {
    const voided = chipForInvestment(
      brokerageRow({ status: TransactionStatus.VOID }),
      TODAY,
    );
    const future = chipForInvestment(
      brokerageRow({ transactionDate: '2026-06-20' }),
      TODAY,
    );

    expect(voided.isVoid).toBe(true);
    expect(future.isFuture).toBe(true);
  });
});

describe('groupInvestmentCalendarRows', () => {
  it('puts a trade and a cash row on their own days', () => {
    const days = groupInvestmentCalendarRows({
      brokerage: [brokerageRow()],
      cash: [withOverrides({ id: 'cash-1', accountId: 'chequing-1', transactionDate: '2026-06-11' })],
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-10')?.investments).toHaveLength(1);
    expect(days.get('2026-06-10')?.transactions).toHaveLength(0);
    expect(days.get('2026-06-11')?.transactions).toHaveLength(1);
  });

  it('reads a timestamped trade date as its calendar day', () => {
    const days = groupInvestmentCalendarRows({
      brokerage: [brokerageRow({ transactionDate: '2026-06-10T00:00:00.000Z' })],
      cash: [],
      accountsById,
      today: TODAY,
    });

    expect(days.get('2026-06-10')?.investments).toHaveLength(1);
  });
});
