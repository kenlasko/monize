import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  occurrenceKind,
  SCHEDULED_KIND_CHIP_CLASSES,
  scheduledKind,
  upcomingBillKind,
} from './scheduled-kind';

describe('upcomingBillKind', () => {
  it('reads a budget row as a reminder, an unknown amount or a bill', () => {
    expect(upcomingBillKind({ amountDue: 0, isReminder: true })).toBe('reminder');
    expect(upcomingBillKind({ amountDue: null, isReminder: false })).toBe('unknown');
    expect(upcomingBillKind({ amountDue: 80, isReminder: false })).toBe('bill');
  });
});

describe('scheduledKind', () => {
  it('classifies a negative amount as a bill', () => {
    expect(scheduledKind({ amount: -1200 })).toBe('bill');
    expect(scheduledKind({ amount: '-0.0001' })).toBe('bill');
  });

  it('classifies a positive amount as a deposit', () => {
    expect(scheduledKind({ amount: 5000 })).toBe('deposit');
    expect(scheduledKind({ amount: '0.0001' })).toBe('deposit');
  });

  it('classifies a zero amount as a reminder, not a deposit', () => {
    expect(scheduledKind({ amount: 0 })).toBe('reminder');
    expect(scheduledKind({ amount: '0.0000' })).toBe('reminder');
    expect(scheduledKind({ amount: -0 })).toBe('reminder');
  });

  it('classifies a transfer as a transfer whatever its amount', () => {
    expect(scheduledKind({ amount: 0, isTransfer: true })).toBe('transfer');
    expect(scheduledKind({ amount: -500, isTransfer: true })).toBe('transfer');
    expect(scheduledKind({ amount: 500, isTransfer: true })).toBe('transfer');
  });

  it('treats an unparseable amount as a reminder rather than a deposit', () => {
    expect(scheduledKind({ amount: 'n/a' })).toBe('reminder');
  });

  describe('occurrenceKind', () => {
    it('classifies from the occurrence\'s own amount when it is known', () => {
      // The template is an outflow; this occurrence was overridden to a credit.
      expect(occurrenceKind({ amount: 50 }, { amount: -100 })).toBe('deposit');
      expect(occurrenceKind({ amount: -50 }, { amount: 100 })).toBe('bill');
    });

    /**
     * The trap the helper exists for: `Number(null)` is 0, which classifies an
     * unpriceable bill as a grey reminder. An exchange rate is positive, so the
     * schedule's sign is still the right answer for direction (issue #1247).
     */
    it('falls back to the schedule\'s sign when the occurrence is unpriceable', () => {
      expect(occurrenceKind({ amount: null }, { amount: -1000 })).toBe('bill');
      expect(occurrenceKind({ amount: null }, { amount: 3000 })).toBe('deposit');
      expect(occurrenceKind({ amount: null }, { amount: '-1000.0000' })).toBe(
        'bill',
      );
    });

    it('keeps a transfer a transfer, priced or not', () => {
      expect(
        occurrenceKind({ amount: null }, { amount: -100, isTransfer: true }),
      ).toBe('transfer');
      expect(
        occurrenceKind({ amount: -100 }, { amount: -100, isTransfer: true }),
      ).toBe('transfer');
    });

    it('keeps a zero-amount reminder a reminder', () => {
      expect(occurrenceKind({ amount: 0 }, { amount: 0 })).toBe('reminder');
      expect(occurrenceKind({ amount: null }, { amount: 0 })).toBe('reminder');
    });
  });

  it('gives every kind its own chip and amount styling', () => {
    const kinds = ['bill', 'deposit', 'transfer', 'reminder'] as const;
    const chips = kinds.map((k) => SCHEDULED_KIND_CHIP_CLASSES[k]);
    const amounts = kinds.map((k) => SCHEDULED_KIND_AMOUNT_CLASSES[k]);
    expect(new Set(chips).size).toBe(kinds.length);
    expect(new Set(amounts).size).toBe(kinds.length);
  });

  describe('a direction the server could not derive', () => {
    it('is unknown, not a guess from the schedule', () => {
      // An unpriceable mixed-sign split posts on either side of zero, so red and
      // green are equally unfounded (issue #1247 re-audit).
      expect(
        occurrenceKind(
          { amount: null, directionAmount: null },
          { amount: -1200 },
        ),
      ).toBe('unknown');
      expect(
        occurrenceKind({ amount: null, directionAmount: null }, { amount: 1200 }),
      ).toBe('unknown');
    });

    it('keeps a provable sign when the server sends one', () => {
      // A top-level investment or a same-signed split: the magnitude is unknown,
      // the side of zero is not.
      expect(
        occurrenceKind(
          { amount: null, directionAmount: -1000 },
          { amount: -1000 },
        ),
      ).toBe('bill');
      expect(
        occurrenceKind({ amount: null, directionAmount: 500 }, { amount: 500 }),
      ).toBe('deposit');
    });

    it('reads the occurrence direction over the occurrence amount', () => {
      // The two disagree only through an override, and the direction is the field
      // that answers "which way", so it wins.
      expect(
        occurrenceKind({ amount: 20, directionAmount: 20 }, { amount: -10 }),
      ).toBe('deposit');
    });

    it('falls back as it always did when the server did not say', () => {
      // An older backend mid rolling deploy sends no direction at all, which is no
      // information rather than "unknown".
      expect(occurrenceKind({ amount: -1350 }, { amount: -1000 })).toBe('bill');
      expect(occurrenceKind({ amount: null }, { amount: -1000 })).toBe('bill');
    });

    it('calls a split made only of transfer lines a transfer, never a reminder', () => {
      const schedule = {
        amount: -100,
        isSplit: true,
        splits: [{ transferAccountId: 'acc-2' }, { transferAccountId: 'acc-3' }],
      };
      expect(occurrenceKind({ amount: -100, directionAmount: -100 }, schedule)).toBe('transfer');
      // A split with a category line is still a bill.
      expect(
        occurrenceKind(
          { amount: -100, directionAmount: -100 },
          { ...schedule, splits: [{ transferAccountId: null }, { transferAccountId: 'acc-2' }] },
        ),
      ).toBe('bill');
    });

    it('reads the occurrence\'s effective lines, not the template alone', () => {
      const occ = { amount: -100, directionAmount: -100 };
      const transfersOnly = {
        amount: -100,
        isSplit: true,
        splits: [{ transferAccountId: 'acc-2' }],
      };
      // An override that turns a transfers-only template into a bill...
      expect(
        occurrenceKind(occ, { ...transfersOnly, nextOverride: { isSplit: false, splits: null } }),
      ).toBe('bill');
      expect(
        occurrenceKind(occ, {
          ...transfersOnly,
          nextOverride: { isSplit: true, splits: [{ transferAccountId: null }, { transferAccountId: 'acc-2' }] },
        }),
      ).toBe('bill');
      // ...and the reverse: a template with a category line, restated as transfers only.
      const mixed = { amount: -100, isSplit: true, splits: [{ transferAccountId: null }, { transferAccountId: 'acc-2' }] };
      expect(occurrenceKind(occ, mixed)).toBe('bill');
      expect(
        occurrenceKind(occ, { ...mixed, nextOverride: { isSplit: true, splits: [{ transferAccountId: 'acc-2' }] } }),
      ).toBe('transfer');
      // An occurrence that names its own override wins over the next one's.
      expect(
        occurrenceKind(
          { ...occ, override: { isSplit: true, splits: [{ transferAccountId: 'acc-2' }] } },
          { ...mixed, nextOverride: null },
        ),
      ).toBe('transfer');
    });

    it('still calls a transfer a transfer, whatever the direction says', () => {
      expect(
        occurrenceKind(
          { amount: null, directionAmount: null },
          { amount: -500, isTransfer: true },
        ),
      ).toBe('transfer');
    });
  });
});
