/**
 * Values in an expression: a text, a number, a reference to an account, a
 * list, a range. Each is read for the field it belongs to, so the wrong kind
 * of value is refused here with its position, before a tree exists.
 */
import { ENTITY_KIND_OF_FIELD, isEntityKind, type CelEntityKind, type EntityIndex } from '@/lib/rule-cel/catalog';
import { Cursor, failAt } from '@/lib/rule-cel/cursor';
import type { Token } from '@/lib/rule-cel/lexer';
import { CEL_UNFILLED, quoteString } from '@/lib/rule-cel/literal';
import { MAX_RULE_TEXT_LENGTH, MAX_RULE_VALUE_LIST, RULE_CONDITION_FIELDS } from '@/lib/rule-fields';
import type { RuleField } from '@/types/transaction-rule';

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export interface ValueContext {
  readonly field: RuleField;
  readonly index: EntityIndex;
}

export type ScalarValue = string | number | boolean | undefined;

/** Tokens that end a value: seeing one where a value should be means it is missing. */
function valueMissing(cursor: Cursor): boolean {
  const token = cursor.peek();
  return token.kind === 'eof' || (token.kind === 'punct' && [')', ']', ','].includes(token.text));
}

function readReference(cursor: Cursor, kind: CelEntityKind, ctx: ValueContext, unfilled: boolean): string {
  const head = cursor.peek();
  if (unfilled && head.kind === 'ident' && head.text === CEL_UNFILLED) {
    cursor.next();
    return '';
  }
  const isCall = head.kind === 'ident' && cursor.isPunct('(', 1);
  if (!isCall) throw failAt(head, 'wrongValueType', { expected: kind });
  if (head.text === 'missing') {
    cursor.next();
    cursor.next();
    const id = cursor.next();
    if (id.kind !== 'string' || id.value === '') throw failAt(id, 'wrongValueType', { expected: 'text' });
    cursor.expectPunct(')');
    return String(id.value);
  }
  if (!isEntityKind(head.text)) throw failAt(head, 'unknownFunction', { name: head.text });
  if (head.text !== kind) throw failAt(head, 'wrongValueType', { expected: kind });
  cursor.next();
  cursor.next();
  const name = cursor.next();
  if (name.kind !== 'string') throw failAt(name, 'wrongValueType', { expected: 'text' });
  const shown = quoteString(String(name.value));
  const matches = ctx.index.find(kind, String(name.value));
  const count = matches.length;
  let numbered: Token | null = null;
  if (cursor.isPunct(',')) {
    cursor.next();
    numbered = cursor.next();
  }
  cursor.expectPunct(')');
  if (count === 0) throw failAt(name, 'unknownEntity', { kind, name: shown });
  if (numbered === null && count > 1) {
    throw failAt(name, 'ambiguousEntity', { name: shown, count, example: `${kind}(${shown}, 1)` });
  }
  const ordinal = numbered === null ? 1 : numbered.kind === 'number' ? Number(numbered.value) : Number.NaN;
  if (numbered !== null && (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > count)) {
    throw failAt(numbered, 'entityOrdinal', { name: shown, count });
  }
  return matches[ordinal - 1].id;
}

function readNumber(cursor: Cursor, unfilled: boolean): number | undefined {
  const head = cursor.peek();
  if (unfilled && head.kind === 'ident' && head.text === CEL_UNFILLED) {
    cursor.next();
    return undefined;
  }
  let sign = 1;
  if (head.kind === 'punct' && head.text === '-') {
    cursor.next();
    sign = -1;
  }
  const number = cursor.peek();
  if (number.kind !== 'number' || !Number.isFinite(number.value)) throw failAt(number, 'wrongValueType', { expected: 'number' });
  cursor.next();
  return sign * Number(number.value);
}

/** One value of the kind the field holds; `unfilled` allows `_` where a value may be left open. */
export function readScalar(cursor: Cursor, ctx: ValueContext, unfilled: boolean): ScalarValue {
  if (valueMissing(cursor)) throw cursor.fail('expectedValue');
  const spec = RULE_CONDITION_FIELDS[ctx.field];
  const entity = ENTITY_KIND_OF_FIELD[spec.kind];
  if (entity) return readReference(cursor, entity, ctx, unfilled);
  if (spec.kind === 'money' || spec.kind === 'dayOfMonth') return readNumber(cursor, unfilled);
  const token = cursor.peek();
  if (spec.kind === 'boolean') {
    if (token.kind !== 'ident' || (token.text !== 'true' && token.text !== 'false')) {
      throw failAt(token, 'wrongValueType', { expected: 'boolean' });
    }
    cursor.next();
    return token.text === 'true';
  }
  if ((spec.kind === 'currency' || spec.kind === 'date') && unfilled && token.kind === 'ident' && token.text === CEL_UNFILLED) {
    cursor.next();
    return '';
  }
  if (token.kind !== 'string') throw failAt(token, 'wrongValueType', { expected: 'text' });
  cursor.next();
  const text = String(token.value);
  if (spec.kind === 'enum' && !(spec.enumValues ?? []).includes(text)) {
    throw failAt(token, 'invalidEnum', { values: (spec.enumValues ?? []).join(', ') });
  }
  if (spec.kind === 'currency' && !CURRENCY_CODE.test(text)) throw failAt(token, 'invalidCurrency');
  if (text.length > MAX_RULE_TEXT_LENGTH) throw failAt(token, 'valueTooLong', { max: MAX_RULE_TEXT_LENGTH });
  return text;
}

/** `[a, b, c]`: every item chosen, at most `MAX_RULE_VALUE_LIST` of them. */
export function readList(cursor: Cursor, ctx: ValueContext): string[] {
  if (!cursor.isPunct('[')) {
    throw valueMissing(cursor) ? cursor.fail('expectedValue') : cursor.fail('wrongValueType', { expected: 'list' });
  }
  cursor.next();
  const items: string[] = [];
  if (cursor.isPunct(']')) {
    cursor.next();
    return items;
  }
  for (;;) {
    const before = cursor.peek();
    items.push(readScalar(cursor, ctx, false) as string);
    if (items.length > MAX_RULE_VALUE_LIST) throw failAt(before, 'listTooLong', { max: MAX_RULE_VALUE_LIST });
    if (!cursor.isPunct(',')) break;
    cursor.next();
  }
  cursor.expectPunct(']');
  return items;
}

/** The two ends of `between(a, b)`; either may be `_` while the rule is being built. */
export function readRange(cursor: Cursor, ctx: ValueContext): (number | string | undefined)[] {
  const low = readScalar(cursor, ctx, true) as number | string | undefined;
  cursor.expectPunct(',');
  const high = readScalar(cursor, ctx, true) as number | string | undefined;
  return [low, high];
}
