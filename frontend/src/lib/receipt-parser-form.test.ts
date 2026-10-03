import { describe, it, expect } from 'vitest';
import {
  blankCategoryRule,
  buildParserDefinition,
  buildParserPayload,
  emptyParserForm,
  parseValidationProblems,
  parserToForm,
  splitDomains,
  splitLines,
  splitWords,
} from './receipt-parser-form';
import type { EmailReceiptParser } from '@/types/email-receipts';

const CATEGORY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('splitting', () => {
  it('splits patterns by line only, so a comma stays in the pattern', () => {
    expect(splitLines('Total: {amount}, tax\r\n\n  Sum {amount}  \n')).toEqual(['Total: {amount}, tax', 'Sum {amount}']);
  });

  it('splits subject words by line or comma', () => {
    expect(splitWords('order confirmation, your receipt\nthanks')).toEqual([
      'order confirmation',
      'your receipt',
      'thanks',
    ]);
  });

  it('splits domains by whitespace, comma or semicolon and drops a pasted @', () => {
    expect(splitDomains('@shop.example.com; other.example\nthird.example, ')).toEqual([
      'shop.example.com',
      'other.example',
      'third.example',
    ]);
  });
});

describe('buildParserDefinition', () => {
  it('is only the version for an empty form', () => {
    expect(buildParserDefinition(emptyParserForm())).toEqual({ version: 1 });
  });

  it('builds every part of the definition', () => {
    const definition = buildParserDefinition(
      emptyParserForm({
        orderId: 'Order {orderid}',
        total: 'Total {amount}\nGrand total {amount}',
        shipping: 'Shipping {amount}',
        discount: 'Discount {amount}',
        startAfter: ' Items ',
        stopAt: 'Subtotal',
        itemPatterns: '{name} x {qty} {price}',
        categoryRules: [
          { uid: 'a', match: ' *cable* ', categoryId: CATEGORY },
          { uid: 'b', match: '', categoryId: '' },
        ],
        defaultCategoryId: CATEGORY,
        shippingCategoryId: OTHER,
      }),
    );
    expect(definition).toEqual({
      version: 1,
      orderId: ['Order {orderid}'],
      total: ['Total {amount}', 'Grand total {amount}'],
      shipping: ['Shipping {amount}'],
      discount: ['Discount {amount}'],
      items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} x {qty} {price}'] },
      categoryRules: [{ match: '*cable*', categoryId: CATEGORY }],
      defaultCategoryId: CATEGORY,
      shippingCategoryId: OTHER,
    });
  });

  it('sends items with no patterns when only a marker is filled, so the server reports it', () => {
    expect(buildParserDefinition(emptyParserForm({ startAfter: 'Items' })).items).toEqual({
      startAfter: 'Items',
      patterns: [],
    });
  });

  it('keeps a half-filled category rule so the server reports the missing half', () => {
    const definition = buildParserDefinition(
      emptyParserForm({ categoryRules: [{ uid: 'a', match: '*x*', categoryId: '' }] }),
    );
    expect(definition.categoryRules).toEqual([{ match: '*x*', categoryId: '' }]);
  });
});

describe('buildParserPayload', () => {
  it('trims the name, nulls a blank payee and splits the lists', () => {
    const payload = buildParserPayload(
      emptyParserForm({
        name: '  Shop  ',
        fromDomains: 'shop.example.com',
        subjectContains: 'order, receipt',
        total: 'Total {amount}',
      }),
    );
    expect(payload).toEqual({
      name: 'Shop',
      payeeId: null,
      fromDomains: ['shop.example.com'],
      subjectContains: ['order', 'receipt'],
      definition: { version: 1, total: ['Total {amount}'] },
    });
  });

  it('carries the chosen payee', () => {
    expect(buildParserPayload(emptyParserForm({ name: 'x', payeeId: CATEGORY })).payeeId).toBe(CATEGORY);
  });
});

describe('parserToForm', () => {
  const parser = (overrides: Partial<EmailReceiptParser> = {}): EmailReceiptParser => ({
    id: 'p-1',
    name: 'Shop',
    payeeId: null,
    fromDomains: ['shop.example.com', 'mail.shop.example.com'],
    subjectContains: ['order'],
    definition: {
      version: 1,
      orderId: ['Order {orderid}'],
      total: ['Total {amount}'],
      items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} {amount}'] },
      categoryRules: [{ match: '*cable*', categoryId: CATEGORY }],
      defaultCategoryId: CATEGORY,
    },
    definitionValid: true,
    definitionErrors: [],
    status: 'approved',
    source: 'manual',
    approvedAt: null,
    revision: 2,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  });

  it('round-trips a stored parser through the form to the same definition', () => {
    const stored = parser();
    const form = parserToForm(stored);
    expect(form.fromDomains).toBe('shop.example.com\nmail.shop.example.com');
    expect(form.categoryRules).toHaveLength(1);
    expect(buildParserDefinition(form)).toEqual(stored.definition);
  });

  it('reads a definition restored as {} as an empty form, never a crash', () => {
    const form = parserToForm(parser({ definition: {}, definitionValid: false }));
    expect(buildParserDefinition(form)).toEqual({ version: 1 });
  });

  it('ignores parts of the wrong shape', () => {
    const form = parserToForm(
      parser({ definition: { total: 'not a list', items: [], categoryRules: [1, null, { match: 5 }] } }),
    );
    expect(form.total).toBe('');
    expect(form.itemPatterns).toBe('');
    expect(form.categoryRules).toHaveLength(1);
  });

  it('gives each category rule row its own key', () => {
    const a = blankCategoryRule();
    const b = blankCategoryRule();
    expect(a.uid).not.toBe(b.uid);
  });
});

describe('parseValidationProblems', () => {
  it('reads the problems a 400 lists', () => {
    expect(
      parseValidationProblems(
        'The parser definition is not valid: total[0]: capture_missing; items.patterns[1]: capture_conflict; categoryRules[2].categoryId: invalid_uuid; (definition): not_object',
      ),
    ).toEqual([
      { path: 'total[0]', code: 'capture_missing' },
      { path: 'items.patterns[1]', code: 'capture_conflict' },
      { path: 'categoryRules[2].categoryId', code: 'invalid_uuid' },
      { path: '', code: 'not_object' },
    ]);
  });

  it('reads a path that has no index', () => {
    expect(parseValidationProblems('x: items.patterns: empty')).toEqual([{ path: 'items.patterns', code: 'empty' }]);
  });

  it('is empty when the message lists none', () => {
    expect(parseValidationProblems('Payee not found')).toEqual([]);
  });
});
