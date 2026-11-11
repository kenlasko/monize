import { describe, it, expect } from 'vitest';
import {
  buildMatchDefinition,
  defaultMatchBy,
  matchByAfterReferenceChange,
  buildParserDefinition,
  buildParserPayload,
  definitionToFormFields,
  discardModeOf,
  emptyParserForm,
  formCanRepresent,
  formatDefinitionJson,
  isTradeDefinition,
  newTradeAccountRule,
  newTradeCurrencyMarker,
  parseDefinitionJson,
  parseValidationProblems,
  parserToForm,
  splitDomains,
  splitLines,
  splitWords,
  toleranceFromString,
  toleranceToString,
  tradeCurrencyChoices,
} from './receipt-parser-form';
import type { EmailReceiptParser } from '@/types/email-receipts';

const CATEGORY = '11111111-1111-4111-8111-111111111111';

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

  it('keeps only the domain of a pasted sender address', () => {
    expect(splitDomains('notifications@o.wealthsimple.com, orders@shop.example.com')).toEqual([
      'o.wealthsimple.com',
      'shop.example.com',
    ]);
  });
});

describe('buildParserDefinition', () => {
  it('is only the version for an empty form', () => {
    expect(buildParserDefinition(emptyParserForm())).toEqual({ version: 2 });
  });

  it('keeps a multi-line pattern (parts joined by \\n) as one pattern, and shows it in the form again', () => {
    const multiLine = 'Receipt from *\\n{amount}\\nPaid';
    const definition = buildParserDefinition(emptyParserForm({ total: `${multiLine}\nTotal {amount}` }));
    expect(definition.total).toEqual([multiLine, 'Total {amount}']);
    expect(formCanRepresent(definition)).toBe(true);
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
        fees: 'Fee {amount}',
        defaultCategory: ' Electronics: Cables ',
        shippingCategory: 'Shipping',
        feesCategory: 'Fees',
      }),
    );
    expect(definition).toEqual({
      version: 2,
      orderId: ['Order {orderid}'],
      total: ['Total {amount}', 'Grand total {amount}'],
      shipping: ['Shipping {amount}'],
      discount: ['Discount {amount}'],
      items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} x {qty} {price}'] },
      fees: ['Fee {amount}'],
      defaultCategory: 'Electronics: Cables',
      shippingCategory: 'Shipping',
      feesCategory: 'Fees',
    });
  });

  it('sends items with no patterns when only a marker is filled, so the server reports it', () => {
    expect(buildParserDefinition(emptyParserForm({ startAfter: 'Items' })).items).toEqual({
      startAfter: 'Items',
      patterns: [],
    });
  });

  it('names categories and leaves a blank one out', () => {
    const definition = buildParserDefinition(emptyParserForm({ defaultCategory: '  ', shippingCategory: 'Shipping' }));
    expect(definition).toEqual({ version: 2, shippingCategory: 'Shipping' });
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
      definition: { version: 2, total: ['Total {amount}'] },
    });
  });

  it('carries the chosen payee', () => {
    expect(buildParserPayload(emptyParserForm({ name: 'x', payeeId: CATEGORY })).payeeId).toBe(CATEGORY);
  });
});

describe('discard', () => {
  it('writes the mode it holds, for a receipt or a trade profile, and leaves it out when it reads', () => {
    expect(buildParserDefinition(emptyParserForm({ discard: 'ignore' }))).toEqual({ version: 2, discard: 'ignore' });
    expect(buildParserDefinition(emptyParserForm({ kind: 'trade', discard: 'delete' })).discard).toBe('delete');
    expect(buildParserDefinition(emptyParserForm())).not.toHaveProperty('discard');
  });

  it('reads it back, and the form can show a definition that holds one', () => {
    for (const discard of ['ignore', 'delete'] as const) {
      expect(definitionToFormFields({ version: 2, discard }).discard).toBe(discard);
      expect(formCanRepresent({ version: 2, total: ['Total {amount}'], discard })).toBe(true);
    }
    expect(definitionToFormFields({ version: 2 }).discard).toBe('');
  });

  it('sends a definition with a mode the form has no option for to the JSON editor', () => {
    expect(formCanRepresent({ version: 2, discard: 'archive' })).toBe(false);
  });

  it('names the mode of a stored definition, or none', () => {
    expect(discardModeOf({ version: 2, discard: 'delete' })).toBe('delete');
    expect(discardModeOf({ version: 2 })).toBeNull();
    expect(discardModeOf({ version: 2, discard: 'archive' })).toBeNull();
    expect(discardModeOf(null)).toBeNull();
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
      version: 2,
      orderId: ['Order {orderid}'],
      total: ['Total {amount}'],
      items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} {amount}'] },
      defaultCategory: 'Electronics: Cables',
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
    expect(form.defaultCategory).toBe('Electronics: Cables');
    expect(buildParserDefinition(form)).toEqual(stored.definition);
  });

  it('reads a definition restored as {} as an empty form, never a crash', () => {
    const form = parserToForm(parser({ definition: {}, definitionValid: false }));
    expect(buildParserDefinition(form)).toEqual({ version: 2 });
  });

  it('ignores parts of the wrong shape', () => {
    const form = parserToForm(
      parser({ definition: { total: 'not a list', items: [], defaultCategory: 5 } }),
    );
    expect(form.total).toBe('');
    expect(form.itemPatterns).toBe('');
    expect(form.defaultCategory).toBe('');
  });
});

describe('linked receipts definitions', () => {
  it('opens a definition with a role, a link key or a link section in JSON mode', () => {
    expect(formCanRepresent({ version: 2, role: 'component', linkKey: ['Contract {link}'] })).toBe(false);
    expect(formCanRepresent({ version: 2, role: 'settlement', link: { daysBefore: 30 } })).toBe(false);
    expect(formCanRepresent({ version: 2, link: { fromDomains: ['shop.example.com'] } })).toBe(false);
    expect(formCanRepresent({ version: 2, total: ['Total {amount}'] })).toBe(true);
  });

  it('reads the eight link codes of a 400', () => {
    expect(
      parseValidationProblems(
        'x: role: role_invalid; linkKey: link_key_requires_component; (definition): link_key_missing; items.patterns[0]: link_capture_requires_settlement; link: link_requires_settlement; link.fromDomains[1]: link_domain_invalid; link.daysBefore: link_days_invalid; role: role_trade_conflict',
      ).map((problem) => problem.code),
    ).toEqual([
      'role_invalid',
      'link_key_requires_component',
      'link_key_missing',
      'link_capture_requires_settlement',
      'link_requires_settlement',
      'link_domain_invalid',
      'link_days_invalid',
      'role_trade_conflict',
    ]);
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

  it('reads the multi-line codes, not the shorter code they start with', () => {
    expect(
      parseValidationProblems('x: total[0]: too_many_lines; categoryRules[1].match: line_break_not_allowed'),
    ).toEqual([
      { path: 'total[0]', code: 'too_many_lines' },
      { path: 'categoryRules[1].match', code: 'line_break_not_allowed' },
    ]);
  });

  it('reads a path that has no index', () => {
    expect(parseValidationProblems('x: items.patterns: empty')).toEqual([{ path: 'items.patterns', code: 'empty' }]);
  });

  it('is empty when the message lists none', () => {
    expect(parseValidationProblems('Payee not found')).toEqual([]);
  });
});

describe('formCanRepresent', () => {
  it('shows a definition of plain line patterns, whatever its version, and an empty one', () => {
    expect(formCanRepresent({})).toBe(true);
    expect(formCanRepresent({ version: 1, total: ['Total {amount}'] })).toBe(true);
    expect(
      formCanRepresent({
        version: 2,
        orderId: ['*#{orderid}'],
        total: ['Total {amount}'],
        items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} {amount}'] },
        fees: ['Fee {amount}'],
        defaultCategory: 'Electronics: Cables',
        shippingCategory: 'Shipping',
        feesCategory: 'Fees',
      }),
    ).toBe(true);
  });

  it.each([
    ['a labelled entry', { version: 2, total: [{ label: 'RAZEM', value: '{amount} zł' }] }],
    ['a labelled order id', { version: 2, orderId: ['*#{orderid}', { label: 'N', value: '{orderid}' }] }],
    ['multi-line items', { version: 2, items: { record: [{ line: '{name}' }, { line: '{amount}' }] } }],
    ['skipLines', { version: 2, items: { skipLines: ['<*>'], patterns: ['{name} {amount}'] } }],
    ['paid', { version: 2, paid: ['Zapłacono {amount}'] }],
    ['a payee', { version: 2, payee: ['Sprzedawca: {payee}'] }],
    ['a line guard', { version: 2, requireLine: ['*PayU*'] }],
    ['single items', { version: 2, items: { single: { name: 'Opis: {name}' } } }],
    ['joinWrapped', { version: 2, items: { patterns: ['{name} {amount} zł'], joinWrapped: true } }],
    ['category rules, an advanced option kept in the JSON', { version: 2, categoryRules: [{ match: '*a*', categoryId: CATEGORY }] }],
    ['a balance tolerance', { version: 2, balanceTolerance: '0.05' }],
    ['a category id of the old kind', { version: 2, defaultCategoryId: CATEGORY }],
    ['an unknown key', { version: 2, note: 'x' }],
    ['an unknown key under items', { version: 2, items: { patterns: ['{name} {amount}'], extra: 1 } }],
    ['a field that is not a list', { version: 2, total: 'Total {amount}' }],
    ['items that are not an object', { version: 2, items: [] }],
    ['a marker that is not text', { version: 2, items: { startAfter: 5, patterns: [] } }],
    ['a default category that is not text', { version: 2, defaultCategory: 5 }],
    ['a definition that is not an object', [1]],
    ['null', null],
  ])('does not show %s: the form would drop it', (_label, definition) => {
    expect(formCanRepresent(definition)).toBe(false);
  });

  it('never drops what it says it can show: the round trip through the form is the definition', () => {
    const definition = {
      version: 2 as const,
      orderId: ['*#{orderid}'],
      total: ['Total {amount}', 'Sum {amount}'],
      shipping: ['Shipping {amount}'],
      discount: ['Discount {amount}'],
      items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} {amount}'] },
      fees: ['Fee {amount}'],
      defaultCategory: 'Electronics: Cables',
      shippingCategory: 'Shipping',
      feesCategory: 'Fees',
    };
    expect(formCanRepresent(definition)).toBe(true);
    const form = { ...emptyParserForm(), ...definitionToFormFields(definition) };
    expect(buildParserDefinition(form)).toEqual(definition);
  });
});

describe('the definition as JSON', () => {
  it('pretty-prints with two spaces, and an absent definition as {}', () => {
    expect(formatDefinitionJson({ version: 2, total: ['T {amount}'] })).toBe(
      '{\n  "version": 2,\n  "total": [\n    "T {amount}"\n  ]\n}',
    );
    expect(formatDefinitionJson(undefined)).toBe('{}');
  });

  it('keeps every version 2 field through a print and a parse', () => {
    const definition = {
      version: 2,
      total: [{ label: 'RAZEM', value: '{amount} zł', within: 3 }],
      items: {
        startAfter: 'od ',
        skipLines: ['<*>'],
        record: [{ line: '{name}' }, { line: '{amount} zł' }, { line: '{qty} × {price} zł', optional: true }],
      },
    };
    expect(parseDefinitionJson(formatDefinitionJson(definition))).toEqual({ ok: true, definition });
  });

  it.each([['not json'], ['[1, 2]'], ['"text"'], ['null'], ['5'], ['']])('refuses %j as a definition', (source) => {
    expect(parseDefinitionJson(source)).toEqual({ ok: false });
  });

  it('sends the JSON editor definition in the payload instead of the form', () => {
    const definition = { version: 2 as const, total: [{ label: 'RAZEM', value: '{amount} zł' }] };
    const payload = buildParserPayload({ ...emptyParserForm(), name: 'A', fromDomains: 'a.example' }, definition);
    expect(payload.definition).toBe(definition);
  });
});

describe('the server codes of version 2', () => {
  it('reads every new code out of a 400 message', () => {
    const message =
      'The parser definition is not valid: version: unsupported_version; total[0].within: out_of_range; items: items_patterns_and_record; items: items_shape_missing; items.skipLines: skip_lines_need_record; items.record: record_name_missing; items: items_single_conflict; items.joinWrapped: join_wrapped_needs_patterns; categoryRules[0].field: invalid_value';
    expect(parseValidationProblems(message)).toEqual([
      { path: 'version', code: 'unsupported_version' },
      { path: 'total[0].within', code: 'out_of_range' },
      { path: 'items', code: 'items_patterns_and_record' },
      { path: 'items', code: 'items_shape_missing' },
      { path: 'items.skipLines', code: 'skip_lines_need_record' },
      { path: 'items.record', code: 'record_name_missing' },
      { path: 'items', code: 'items_single_conflict' },
      { path: 'items.joinWrapped', code: 'join_wrapped_needs_patterns' },
      { path: 'categoryRules[0].field', code: 'invalid_value' },
    ]);
  });
});

describe('the lines source', () => {
  it('is the text by default, and is left out of the definition', () => {
    expect(emptyParserForm().source).toBe('text');
    expect(buildParserDefinition(emptyParserForm())).toEqual({ version: 2 });
  });

  it('writes source html only when the form says html', () => {
    expect(buildParserDefinition(emptyParserForm({ source: 'html' }))).toEqual({ version: 2, source: 'html' });
    expect(buildParserDefinition(emptyParserForm({ source: 'text' }))).not.toHaveProperty('source');
  });

  it('reads the source of a stored definition: html is html, anything else the text', () => {
    expect(definitionToFormFields({ version: 2, source: 'html' }).source).toBe('html');
    expect(definitionToFormFields({ version: 2, source: 'text' }).source).toBe('text');
    expect(definitionToFormFields({ version: 2 }).source).toBe('text');
    expect(definitionToFormFields({}).source).toBe('text');
  });

  it('can show a definition with a valid source, and not one with another', () => {
    expect(formCanRepresent({ version: 2, source: 'html', total: ['Total {amount}'] })).toBe(true);
    expect(formCanRepresent({ version: 2, source: 'text' })).toBe(true);
    expect(formCanRepresent({ version: 2, source: 'pdf' })).toBe(false);
    expect(formCanRepresent({ version: 2, source: 5 })).toBe(false);
  });

  it('round-trips an html parser through the form to the same definition', () => {
    const definition = { version: 2 as const, source: 'html' as const, total: ['Total {amount}'], items: { patterns: ['{name} {amount}'] } };
    expect(formCanRepresent(definition)).toBe(true);
    const form = { ...emptyParserForm(), ...definitionToFormFields(definition) };
    expect(buildParserDefinition(form)).toEqual(definition);
  });

  it('carries the source into a parser form', () => {
    const parser = { definition: { version: 2, source: 'html' }, name: 'x', payeeId: null, fromDomains: [], subjectContains: [] } as unknown as EmailReceiptParser;
    expect(parserToForm(parser).source).toBe('html');
  });
});

describe('tolerance text', () => {
  it.each([
    [0.5, '0.50'],
    [5, '5.00'],
    [0.07, '0.07'],
    [1.25, '1.25'],
  ])('writes %s as %s in integer cents', (value, text) => {
    expect(toleranceToString(value)).toBe(text);
  });

  it.each([[null], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('leaves the key out for %s', (value) => {
    expect(toleranceToString(value)).toBeNull();
  });

  it.each([
    ['0.50', 0.5],
    ['5', 5],
    ['2.5', 2.5],
    ['0.07', 0.07],
  ])('reads %s as %s', (text, value) => {
    expect(toleranceFromString(text)).toBe(value);
  });

  it.each([[''], ['-1'], ['1.234'], ['1e2'], ['abc'], ['1.'], ['.5'], ['1000']])('refuses %j, which the form cannot hold', (text) => {
    expect(toleranceFromString(text)).toBeNull();
  });
});

describe('the matching section', () => {
  it('sends nothing for a form that changes nothing, so an old profile keeps its matching', () => {
    expect(buildMatchDefinition(emptyParserForm())).toBeNull();
    expect(buildParserDefinition(emptyParserForm({ total: 'Total {amount}' }))).toEqual({ version: 2, total: ['Total {amount}'] });
  });

  it('writes only what differs from the default', () => {
    const form = emptyParserForm({
      reference: 'Ref {reference}',
      matchBy: ['reference', 'amount_payee'],
      matchReferenceIn: ['description'],
      matchDaysBefore: 0,
      matchDaysAfter: 30,
      matchTolerance: 0.5,
    });
    expect(buildParserDefinition(form)).toEqual({
      version: 2,
      reference: ['Ref {reference}'],
      match: {
        by: ['reference', 'amount_payee'],
        referenceIn: ['description'],
        daysBefore: 0,
        daysAfter: 30,
        amountTolerance: '0.50',
      },
    });
  });

  it('keeps a window of zero days, which is not "unset"', () => {
    expect(buildMatchDefinition(emptyParserForm({ matchDaysBefore: 0 }))).toEqual({ daysBefore: 0 });
  });

  it('defaults to the reference first only when the profile reads a reference', () => {
    expect(defaultMatchBy(false)).toEqual(['orderId', 'amount_payee', 'amount_date']);
    expect(defaultMatchBy(true)).toEqual(['reference', 'orderId', 'amount_payee', 'amount_date']);
    // That default is no change either way.
    expect(buildMatchDefinition(emptyParserForm({ reference: 'Ref {reference}', matchBy: defaultMatchBy(true) }))).toBeNull();
    // The plain order with a reference present is the person's choice and is written.
    expect(buildMatchDefinition(emptyParserForm({ reference: 'Ref {reference}' }))).toEqual({
      by: ['orderId', 'amount_payee', 'amount_date'],
    });
  });

  it('puts the reference first on its first pattern, and takes it out on the last one, only from the default order', () => {
    expect(matchByAfterReferenceChange(defaultMatchBy(false), false, true)).toEqual(defaultMatchBy(true));
    expect(matchByAfterReferenceChange(defaultMatchBy(true), true, false)).toEqual(defaultMatchBy(false));
    // An order the person arranged is left alone, and so is a change that adds no pattern.
    expect(matchByAfterReferenceChange(['amount_date', 'orderId'], false, true)).toEqual(['amount_date', 'orderId']);
    expect(matchByAfterReferenceChange(defaultMatchBy(true), true, true)).toEqual(defaultMatchBy(true));
  });

  it('reads the effective matching the server answers: the defaults are shown but not sent back', () => {
    const effective = {
      version: 2,
      reference: ['Ref {reference}'],
      match: {
        by: ['reference', 'orderId', 'amount_payee', 'amount_date'],
        referenceIn: ['description', 'payee', 'referenceNumber'],
        daysBefore: 3,
        daysAfter: 14,
        amountTolerance: '0.00',
      },
    };
    const fields = definitionToFormFields(effective);
    expect(fields).toMatchObject({ matchBy: defaultMatchBy(true), matchDaysBefore: 3, matchDaysAfter: 14, matchTolerance: 0 });
    expect(buildParserDefinition({ ...emptyParserForm(), ...fields })).toEqual({
      version: 2,
      reference: ['Ref {reference}'],
    });
    expect(formCanRepresent(effective)).toBe(true);
  });

  it('reads a stored definition back into the same form fields', () => {
    const definition = {
      version: 2,
      reference: ['Ref {reference}'],
      match: { by: ['reference', 'orderId'], daysBefore: 1, amountTolerance: '1.50' },
      tag: 'Shop',
      aiCategories: true,
    };
    const fields = definitionToFormFields(definition);
    expect(fields).toMatchObject({
      reference: 'Ref {reference}',
      matchBy: ['reference', 'orderId'],
      matchDaysBefore: 1,
      matchDaysAfter: null,
      matchTolerance: 1.5,
      tagEnabled: true,
      tagName: 'Shop',
      aiCategories: true,
    });
    expect(buildParserDefinition({ ...emptyParserForm(), ...fields })).toEqual(definition);
  });

  it('falls back to the defaults for a list that is not a choice of the closed set', () => {
    const fields = definitionToFormFields({ match: { by: ['nonsense'], referenceIn: [] } });
    expect(fields.matchBy).toEqual(['orderId', 'amount_payee', 'amount_date']);
    expect(fields.matchReferenceIn).toEqual(['description', 'payee', 'referenceNumber']);
  });

  it.each([
    [{ match: { by: ['reference'] } }, true],
    [{ match: { by: [] } }, false],
    [{ match: { by: ['reference', 'reference'] } }, false],
    [{ match: { by: ['made_up'] } }, false],
    [{ match: { referenceIn: ['description', 'description'] } }, false],
    [{ match: { daysBefore: 61 } }, false],
    [{ match: { daysAfter: 90 } }, true],
    [{ match: { daysAfter: 91 } }, false],
    [{ match: { daysBefore: 1.5 } }, false],
    [{ match: { amountTolerance: '5.00' } }, true],
    [{ match: { amountTolerance: '5.01' } }, false],
    [{ match: { amountTolerance: 0.5 } }, false],
    [{ match: { extra: 1 } }, false],
    [{ match: 'x' }, false],
    [{ tag: 'Shop' }, true],
    [{ tag: 5 }, false],
    [{ aiCategories: true }, true],
    [{ aiCategories: 'yes' }, false],
    [{ reference: ['Ref {reference}'] }, true],
    [{ reference: 'Ref' }, false],
  ])('says whether the form can hold %j: %s', (definition, expected) => {
    expect(formCanRepresent({ version: 2, ...definition })).toBe(expected);
  });

  it('gives a tag switched on with no name the profile\'s own name', () => {
    expect(buildParserDefinition(emptyParserForm({ name: 'Allegro', tagEnabled: true }))).toMatchObject({ tag: 'Allegro' });
    expect(buildParserDefinition(emptyParserForm({ name: 'Allegro', tagEnabled: false, tagName: 'X' }))).not.toHaveProperty('tag');
  });

  it('writes aiCategories only when it is on', () => {
    expect(buildParserDefinition(emptyParserForm({ aiCategories: true }))).toMatchObject({ aiCategories: true });
    expect(buildParserDefinition(emptyParserForm())).not.toHaveProperty('aiCategories');
  });
});

describe('a trade profile', () => {
  const RRSP_CAD = '33333333-3333-4333-8333-333333333333';
  const RRSP_USD = '44444444-4444-4444-8444-444444444444';
  const TFSA = '55555555-5555-4555-8555-555555555555';
  // Two RRSP accounts the broker prints the same way, told apart by the trade's currency.
  const definition = {
    version: 2,
    source: 'html',
    trade: {
      action: ['You {action} *'],
      symbol: ['Symbol: {symbol}'],
      quantity: ['Shares: {quantity}'],
      total: ['Total: {amount}'],
      price: ['Price: {amount}'],
      commission: ['Commission: {amount}'],
      date: ['Date: {date}'],
      account: ['Account: {account}'],
      accountRules: [
        { match: 'RRSP', accountId: RRSP_USD, currency: 'USD' },
        { match: 'RRSP', accountId: RRSP_CAD, currency: 'CAD' },
        { match: 'TFSA*', accountId: TFSA },
      ],
      defaultAccountId: TFSA,
      currencyMarkers: [
        { match: '*U.S. dollars*', currency: 'USD' },
        { match: '*Canadian dollars*', currency: 'CAD' },
      ],
    },
    requireLine: ['*order has been filled*'],
    skipIfLine: ['*cancelled*'],
    waitIfLine: ['*partially filled*'],
  };

  it('is shown in the form and round-trips through it to the same definition', () => {
    expect(formCanRepresent(definition)).toBe(true);
    const fields = definitionToFormFields(definition);
    expect(fields.kind).toBe('trade');
    expect(fields.tradeAction).toBe('You {action} *');
    expect(fields.tradeAccountRules.map(({ match, currency, accountId }) => ({ match, currency, accountId }))).toEqual([
      { match: 'RRSP', currency: 'USD', accountId: RRSP_USD },
      { match: 'RRSP', currency: 'CAD', accountId: RRSP_CAD },
      { match: 'TFSA*', currency: '', accountId: TFSA },
    ]);
    expect(fields.tradeCurrencyMarkers.map(({ match, currency }) => ({ match, currency }))).toEqual([
      { match: '*U.S. dollars*', currency: 'USD' },
      { match: '*Canadian dollars*', currency: 'CAD' },
    ]);
    // Each row has its own key for the list, which is never sent.
    expect(new Set(fields.tradeAccountRules.map((rule) => rule.id)).size).toBe(3);
    expect(buildParserDefinition({ ...emptyParserForm(), ...fields })).toEqual(definition);
  });

  it('always sends the trade section, so an empty one is reported rather than read as a receipt profile', () => {
    expect(buildParserDefinition(emptyParserForm({ kind: 'trade' }))).toEqual({ version: 2, trade: {} });
  });

  it('writes no receipt key, whatever the receipt fields hold', () => {
    const form = emptyParserForm({ kind: 'trade', total: 'Total {amount}', tradeSymbol: 'Symbol: {symbol}', tagEnabled: true, tagName: 'x' });
    expect(buildParserDefinition(form)).toEqual({ version: 2, trade: { symbol: ['Symbol: {symbol}'] } });
  });

  it('drops a row left wholly blank and sends a half-filled one for the server to name what is missing', () => {
    const form = emptyParserForm({
      kind: 'trade',
      tradeAccountRules: [newTradeAccountRule(), { ...newTradeAccountRule(), match: ' RRSP ' }],
      tradeCurrencyMarkers: [newTradeCurrencyMarker(), { ...newTradeCurrencyMarker(), currency: 'USD' }],
    });
    expect(buildParserDefinition(form).trade).toEqual({
      accountRules: [{ match: 'RRSP', accountId: '' }],
      currencyMarkers: [{ match: '', currency: 'USD' }],
    });
  });

  it('leaves out an empty share-count list, which a dividend profile reads without, and shows such a profile in the form', () => {
    const dividend = {
      version: 2,
      trade: {
        action: ['*{action} payment*'],
        symbol: ['Security: {symbol}'],
        total: ['Amount paid: {amount}'],
        date: ['Pay date: {date}'],
      },
    };
    const form = emptyParserForm({
      kind: 'trade',
      tradeAction: '*{action} payment*',
      tradeSymbol: 'Security: {symbol}',
      tradeTotal: 'Amount paid: {amount}',
      tradeDate: 'Pay date: {date}',
    });
    const built = buildParserDefinition(form);
    expect(built).toEqual(dividend);
    expect(built.trade).not.toHaveProperty('quantity');

    expect(formCanRepresent(dividend)).toBe(true);
    const fields = definitionToFormFields(dividend);
    expect(fields.tradeQuantity).toBe('');
    expect(buildParserDefinition({ ...emptyParserForm(), ...fields })).toEqual(dividend);
  });

  it('sends no payee for a trade profile', () => {
    expect(buildParserPayload(emptyParserForm({ kind: 'trade', payeeId: 'payee-1' })).payeeId).toBeNull();
  });

  it('is edited as JSON when it holds what the form cannot show', () => {
    const withTrade = (trade: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
      version: 2,
      trade: { action: ['{action}'], ...trade },
      ...rest,
    });
    expect(formCanRepresent(withTrade({}))).toBe(true);
    // A receipt key beside the trade section (the server refuses the mix).
    expect(formCanRepresent(withTrade({}, { total: ['Total {amount}'] }))).toBe(false);
    // A labelled entry.
    expect(formCanRepresent(withTrade({ symbol: [{ label: 'Symbol', value: '{symbol}' }] }))).toBe(false);
    // A key the form has no field for.
    expect(formCanRepresent(withTrade({ extra: true }))).toBe(false);
    expect(formCanRepresent(withTrade({ accountRules: [{ match: 'x', accountId: RRSP_CAD, note: 'y' }] }))).toBe(false);
    // Values the form would drop or could not hold.
    expect(formCanRepresent(withTrade({ accountRules: [{ match: 'x', accountId: RRSP_CAD, currency: '' }] }))).toBe(false);
    expect(formCanRepresent(withTrade({ accountRules: [{ match: '', accountId: '' }] }))).toBe(false);
    expect(formCanRepresent(withTrade({ accountRules: [{ match: 'x', accountId: 5 }] }))).toBe(false);
    expect(formCanRepresent(withTrade({ currencyMarkers: [{ match: 'x' }] }))).toBe(false);
    expect(formCanRepresent(withTrade({ defaultAccountId: '' }))).toBe(false);
    expect(formCanRepresent({ version: 2, trade: 'yes' })).toBe(false);
  });

  it('keeps a code the server would refuse as it is, so the server names it', () => {
    const odd = { version: 2, trade: { currencyMarkers: [{ match: '*US$*', currency: 'usd' }] } };
    expect(formCanRepresent(odd)).toBe(true);
    expect(buildParserDefinition({ ...emptyParserForm(), ...definitionToFormFields(odd) })).toEqual(odd);
  });

  it('marks a stored definition with a trade section', () => {
    expect(isTradeDefinition(definition)).toBe(true);
    expect(isTradeDefinition({ version: 2, total: ['Total {amount}'] })).toBe(false);
    expect(isTradeDefinition(null)).toBe(false);
  });
});

describe('tradeCurrencyChoices', () => {
  it('offers the base currency first, the other active ones A-Z, then a held code neither lists', () => {
    expect(tradeCurrencyChoices('CAD', ['USD', 'CAD', 'EUR', 'USD'], ['', 'GBP', 'USD'])).toEqual(['CAD', 'EUR', 'USD', 'GBP']);
  });
});

describe('the trade codes', () => {
  it('reads the trade codes out of a 400 message, beside the known ones', () => {
    const message =
      'The parser definition is not valid: total: trade_conflict; trade.total: trade_amount_missing; trade.defaultAccountId: trade_account_missing; trade.accountRules[1].currency: invalid_currency; trade.currencyMarkers[0].match: empty';
    expect(parseValidationProblems(message)).toEqual([
      { path: 'total', code: 'trade_conflict' },
      { path: 'trade.total', code: 'trade_amount_missing' },
      { path: 'trade.defaultAccountId', code: 'trade_account_missing' },
      { path: 'trade.accountRules[1].currency', code: 'invalid_currency' },
      { path: 'trade.currencyMarkers[0].match', code: 'empty' },
    ]);
  });
});
