import { describe, it, expect } from 'vitest';
import { qaField, qaMissing, qaPaymentReading, qaTransferReading } from '@/test/quick-add-fixtures';
import { chipFields, chipState, mergePins, pinsWithoutIds, quickAddFigure } from './quick-add-chips';

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

describe('chipState of a field the reader cleared', () => {
  it('is Typed, the reader\'s own choice of none, when the reading names it theirs', () => {
    const reading = qaPaymentReading({ payee: qaMissing('pinned'), category: qaMissing('pinned') });
    expect(chipState(reading, 'payee')).toEqual({ tier: 'typed', need: null });
    expect(chipState(reading, 'category')).toEqual({ tier: 'typed', need: null });
  });

  it('is Typed when the pins clear it, whatever source the empty value carries', () => {
    const reading = qaPaymentReading({ category: qaMissing() });
    expect(chipState(reading, 'category', { clear: ['category'] })).toEqual({ tier: 'typed', need: null });
    // Not cleared: a missing category still needs the reader.
    expect(chipState(reading, 'category')).toEqual({ tier: 'needs', need: { kind: 'missing' } });
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

  it('clears a field so it is not guessed again, adding to what is already cleared', () => {
    const payeeCleared = mergePins({ payeeId: 'p1', kind: 'deposit' }, { payeeId: undefined, clear: ['payee'] });
    expect(payeeCleared).toEqual({ kind: 'deposit', clear: ['payee'] });
    // In one fixed order, so the same choices are the same request.
    expect(mergePins(payeeCleared, { categoryId: undefined, clear: ['category'] })).toEqual({
      kind: 'deposit',
      clear: ['payee', 'category'],
    });
    expect(mergePins({ clear: ['category'] }, { clear: ['payee'] }).clear).toEqual(['payee', 'category']);
  });

  it('takes a field off the cleared list once the reader picks a value for it', () => {
    const pins = mergePins({ clear: ['payee', 'category'] }, { payeeName: 'Corner Cafe' });
    expect(pins).toEqual({ payeeName: 'Corner Cafe', clear: ['category'] });
    expect(mergePins(pins, { categoryId: 'c1' })).toEqual({ payeeName: 'Corner Cafe', categoryId: 'c1' });
  });
});

describe('pinsWithoutIds', () => {
  it('keeps what names nothing that can be gone, and drops every id', () => {
    expect(
      pinsWithoutIds({
        kind: 'deposit',
        amount: 20,
        date: '2026-11-19',
        accountId: 'a1',
        toAccountId: 'a2',
        payeeId: 'p1',
        categoryId: 'c1',
        clear: ['category'],
      }),
    ).toEqual({ kind: 'deposit', amount: 20, date: '2026-11-19', clear: ['category'] });
  });
});

describe('quickAddFigure', () => {
  const format = {
    formatCurrency: (value: number, code?: string) => `${code}:${value.toFixed(2)}`,
    formatNumber: (value: number, decimals?: number) => value.toFixed(decimals),
    defaultCurrency: 'USD',
  };

  it('reads an amount in the account\'s currency', () => {
    expect(quickAddFigure(qaPaymentReading(), 84.37, format)).toBe('USD:84.37');
  });

  it('reads a figure typed in another currency in that one, with its code', () => {
    const reading = qaPaymentReading({
      amount: qaField(20),
      blockers: ['foreignCurrency'],
      foreignAmount: { currencyCode: 'EUR', amount: 20 },
    });
    expect(quickAddFigure(reading, 20, format)).toBe('EUR:20.00 EUR');
  });

  it('reads a typed currency with its code while no account is known, never as the default currency', () => {
    const reading = qaPaymentReading({
      amount: qaField(20),
      account: qaMissing(),
      blockers: ['missingAccount'],
      foreignAmount: { currencyCode: 'EUR', amount: 20 },
    });
    expect(quickAddFigure(reading, 20, format)).toBe('EUR:20.00 EUR');
  });

  it('reads one in a currency it cannot name as a bare figure, never the account\'s', () => {
    const reading = qaPaymentReading({
      amount: qaField(20),
      blockers: ['foreignCurrency'],
      foreignAmount: { currencyCode: null, amount: 20 },
    });
    expect(quickAddFigure(reading, 20, format)).toBe('20.00');
  });
});
