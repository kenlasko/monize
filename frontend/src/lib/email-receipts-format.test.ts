import { describe, it, expect } from 'vitest';
import {
  fromReceiptUnits,
  canRecognizeWithAi,
  isReceiptActionable,
  readParsedReceipt,
  senderDomain,
  shownReceiptState,
} from './email-receipts-format';

describe('fromReceiptUnits', () => {
  it('divides 1/10000 units once', () => {
    expect(fromReceiptUnits(199_800)).toBe(19.98);
    expect(fromReceiptUnits(0)).toBe(0);
    expect(fromReceiptUnits(5)).toBe(0.0005);
  });
});

describe('readParsedReceipt', () => {
  it('is null when the email has not been parsed', () => {
    expect(readParsedReceipt(null)).toBeNull();
    expect(readParsedReceipt('x')).toBeNull();
    expect(readParsedReceipt([])).toBeNull();
  });

  it('keeps a stated zero and treats a missing or non-numeric amount as unknown', () => {
    const parsed = readParsedReceipt({ total: 0, shipping: '5', discount: null, complete: true });
    expect(parsed).toMatchObject({ total: 0, shipping: null, discount: null, complete: true, orderId: null });
  });

  it('reads items defensively and drops the ones that are not items', () => {
    const parsed = readParsedReceipt({
      items: [
        { name: 'Cable', qty: 2, amount: 199_800, categoryId: 'c-1' },
        { name: 'No amount' },
        { amount: 5 },
        'junk',
        { name: 'Bad qty', qty: 'x', amount: 10, categoryId: '' },
      ],
      reason: 'items_unbalanced',
    });
    expect(parsed?.items).toEqual([
      { name: 'Cable', qty: 2, amount: 199_800, categoryId: 'c-1' },
      { name: 'Bad qty', qty: 1, amount: 10, categoryId: null },
    ]);
    expect(parsed?.reason).toBe('items_unbalanced');
    expect(parsed?.complete).toBe(false);
  });

  it('ignores a reason it does not know and an items field that is not a list', () => {
    const parsed = readParsedReceipt({ items: 'x', reason: 'something_new' });
    expect(parsed?.items).toEqual([]);
    expect(parsed?.reason).toBeNull();
  });
});

describe('senderDomain', () => {
  it('returns the lower-cased domain of an address', () => {
    expect(senderDomain('Orders@Shop.Example.com')).toBe('shop.example.com');
    expect(senderDomain('a@b@c.example')).toBe('c.example');
  });

  it('is empty when there is no domain', () => {
    expect(senderDomain('no-at-sign')).toBe('');
  });
});

describe('shownReceiptState', () => {
  it('is the status for every status but review', () => {
    expect(shownReceiptState({ status: 'unmatched', displayState: null })).toBe('unmatched');
    expect(shownReceiptState({ status: 'ignored', displayState: null })).toBe('ignored');
  });

  it('is what the request says for a review email', () => {
    expect(shownReceiptState({ status: 'review', displayState: 'applied' })).toBe('applied');
    expect(shownReceiptState({ status: 'review', displayState: 'pending_ai' })).toBe('pending_ai');
  });

  it('never shows a review email with no display state as waiting for approval', () => {
    expect(shownReceiptState({ status: 'review', displayState: null })).toBe('request_missing');
  });
});

describe('isReceiptActionable', () => {
  it.each([
    ['skipped', null, false],
    ['ignored', null, false],
    ['review', 'applied', false],
    ['review', 'proposed', true],
    ['unmatched', null, true],
  ] as const)('%s / %s is %s', (status, displayState, expected) => {
    expect(isReceiptActionable({ status, displayState })).toBe(expected);
  });
});

describe('canRecognizeWithAi', () => {
  it.each([
    ['no_parser', null, true],
    ['parse_failed', null, true],
    ['unmatched', null, true],
    ['ambiguous', null, true],
    ['review_conflict', null, true],
    ['review', 'dismissed', true],
    ['review', 'expired', true],
    ['review', 'request_missing', true],
    ['review', null, true],
    ['review', 'proposed', false],
    ['review', 'pending_ai', false],
    ['review', 'applied', false],
    ['ignored', null, false],
    ['skipped', null, false],
    ['pending', null, false],
  ] as const)('%s / %s is %s', (status, displayState, expected) => {
    expect(canRecognizeWithAi({ status, displayState })).toBe(expected);
  });
});

describe('readParsedReceipt source', () => {
  it('keeps who read the email, and leaves it absent when the server did not say', () => {
    expect(readParsedReceipt({ source: 'ai', items: [] })?.source).toBe('ai');
    expect(readParsedReceipt({ source: 'parser', items: [] })?.source).toBe('parser');
    expect(readParsedReceipt({ items: [] })).not.toHaveProperty('source');
    expect(readParsedReceipt({ source: 'robot', items: [] })).not.toHaveProperty('source');
  });
});
