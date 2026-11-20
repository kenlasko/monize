import { describe, it, expect } from 'vitest';
import { qaField, qaMissing, qaPaymentReading, qaTransferReading } from '@/test/quick-add-fixtures';
import { chipFields, chipState, mergePins } from './quick-add-chips';

describe('chipState', () => {
  it('is Typed for a typed or pinned value', () => {
    const reading = qaPaymentReading({ amount: qaField(84.37, 'pinned') });
    expect(chipState(reading, 'payee')).toEqual({ tier: 'typed', need: null });
    expect(chipState(reading, 'amount')).toEqual({ tier: 'typed', need: null });
  });

  it('is Guessed for an inferred value and Assumed for a default', () => {
    const reading = qaPaymentReading();
    expect(chipState(reading, 'kind').tier).toBe('guessed');
    expect(chipState(reading, 'account').tier).toBe('assumed');
    expect(chipState(reading, 'date').tier).toBe('assumed');
  });

  it('needs the reader for a missing value', () => {
    const reading = qaPaymentReading({ amount: qaMissing() });
    expect(chipState(reading, 'amount')).toEqual({ tier: 'needs', need: { kind: 'missing' } });
  });

  it('needs the reader for an ambiguous value, counting every match', () => {
    const reading = qaPaymentReading({
      account: qaField({ id: 'a', name: 'Visa', currencyCode: 'USD' }, 'typed', {
        ambiguous: true,
        alternatives: [{ id: 'b', name: 'Visa Gold', currencyCode: 'USD' }],
      }),
    });
    expect(chipState(reading, 'account')).toEqual({ tier: 'needs', need: { kind: 'matches', count: 2 } });
  });

  it('needs the reader for a new payee read from the words, and names it when pinned', () => {
    const typed = qaPaymentReading({ payee: qaField({ id: null, name: 'Corner Cafe' }) });
    expect(chipState(typed, 'payee')).toEqual({ tier: 'needs', need: { kind: 'new' } });
    const pinned = qaPaymentReading({ payee: qaField({ id: null, name: 'Corner Cafe' }, 'pinned') });
    expect(chipState(pinned, 'payee')).toEqual({ tier: 'typed', need: { kind: 'new' } });
  });
});

describe('chipFields', () => {
  it('shows a category for a payment and a to-account for a transfer', () => {
    expect(chipFields(qaPaymentReading())).toEqual(['kind', 'amount', 'date', 'account', 'payee', 'category']);
    expect(chipFields(qaTransferReading())).toEqual(['kind', 'amount', 'date', 'account', 'toAccount', 'payee']);
  });
});

describe('mergePins', () => {
  it('adds a pin and drops one set back to nothing', () => {
    const pins = mergePins({ payeeName: 'Corner Cafe' }, { payeeId: 'p1', payeeName: undefined });
    expect(pins).toEqual({ payeeId: 'p1' });
    expect(mergePins(pins, { kind: 'deposit' })).toEqual({ payeeId: 'p1', kind: 'deposit' });
  });
});
