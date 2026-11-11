import { describe, it, expect } from 'vitest';
import { checkProfileFields, isValidReceiptDomain, serverFieldProblems } from './receipt-parser-required';

const filled = { name: 'Allegro', fromDomains: 'allegro.pl', subjectContains: '', jsonInvalid: false };

describe('checkProfileFields', () => {
  it('finds nothing wrong with a named profile for one domain', () => {
    expect(checkProfileFields(filled)).toEqual([]);
  });

  it('reports a blank name and no domain, in the order of the dialog', () => {
    expect(checkProfileFields({ ...filled, name: '  ', fromDomains: ' \n ' })).toEqual([
      { field: 'name', code: 'missing' },
      { field: 'fromDomains', code: 'missing' },
    ]);
  });

  it('names each entry that is not a domain', () => {
    expect(checkProfileFields({ ...filled, fromDomains: 'allegro.pl, localhost\nshop_x.com' })).toEqual([
      { field: 'fromDomains', code: 'invalid', values: ['localhost', 'shop_x.com'] },
    ]);
  });

  it('reports more domains than the server takes', () => {
    const domains = Array.from({ length: 11 }, (_, i) => `shop${i}.example.com`).join('\n');
    expect(checkProfileFields({ ...filled, fromDomains: domains })).toEqual([{ field: 'fromDomains', code: 'too_many' }]);
  });

  it('reports too many or too long subject words', () => {
    const many = Array.from({ length: 11 }, (_, i) => `w${i}`).join('\n');
    expect(checkProfileFields({ ...filled, subjectContains: many })).toEqual([{ field: 'subjectContains', code: 'too_many' }]);
    expect(checkProfileFields({ ...filled, subjectContains: 'x'.repeat(101) })).toEqual([
      { field: 'subjectContains', code: 'too_long' },
    ]);
  });

  it('reports JSON that does not parse', () => {
    expect(checkProfileFields({ ...filled, jsonInvalid: true })).toEqual([{ field: 'definition', code: 'json_invalid' }]);
  });
});

describe('isValidReceiptDomain', () => {
  it('reads a domain as the server stores it: lower-case, trailing dot dropped', () => {
    expect(isValidReceiptDomain('Shop.Example.COM.')).toBe(true);
    expect(isValidReceiptDomain('shop')).toBe(false);
    expect(isValidReceiptDomain('-shop.com')).toBe(false);
    expect(isValidReceiptDomain(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`)).toBe(false);
  });
});

describe('serverFieldProblems', () => {
  it('reads the fields a DTO refusal names at the start of a sentence', () => {
    expect(
      serverFieldProblems(
        'each value of fromDomains must be a host name such as shop.example.com. name must be shorter than or equal to 100 characters',
      ),
    ).toEqual([
      { field: 'name', code: 'server' },
      { field: 'fromDomains', code: 'server' },
    ]);
  });

  it('does not read a definition path or prose as a field', () => {
    expect(serverFieldProblems('The profile definition is not valid: items.single.name: empty')).toEqual([]);
    expect(serverFieldProblems('Payee not found')).toEqual([]);
  });
});
