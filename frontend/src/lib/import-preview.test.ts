import { describe, it, expect } from 'vitest';
import {
  checkState,
  payeeTip,
  pruneChoices,
  selectionFor,
  withChoice,
  withKeysChecked,
  withRowChecked,
  type RowChoices,
} from './import-preview';
import type { ImportPreviewPayee } from '@/types/import-preview';

describe('the selection', () => {
  const NONE: RowChoices = new Map();
  const KEYS = ['ref:a', 'ref:b', 'ref:c'];

  it('starts with every row checked: an untouched preview imports them all', () => {
    expect(selectionFor(KEYS, NONE)).toEqual({
      importKeys: ['ref:a', 'ref:b', 'ref:c'],
      excludeKeys: [],
      skipCount: 0,
    });
  });

  it('sorts the unchecked rows into those skipped for now and those added to the exceptions', () => {
    const choices = withChoice(withRowChecked(withRowChecked(NONE, 'ref:a', false), 'ref:c', false), 'ref:c', 'except');
    expect(selectionFor(KEYS, choices)).toEqual({
      importKeys: ['ref:b'],
      excludeKeys: ['ref:c'],
      skipCount: 1,
    });
  });

  it('ignores a choice about a key that is not offered', () => {
    expect(selectionFor(['ref:a'], withChoice(NONE, 'ref:z', 'except'))).toEqual({
      importKeys: ['ref:a'],
      excludeKeys: [],
      skipCount: 0,
    });
  });

  it('skips an unchecked row for now by default', () => {
    expect([...withRowChecked(NONE, 'ref:a', false)]).toEqual([['ref:a', 'skip']]);
  });

  it('keeps the choice a row already had when it is unchecked again, and forgets it once checked', () => {
    const excepted = withChoice(NONE, 'ref:a', 'except');
    expect(withRowChecked(excepted, 'ref:a', false).get('ref:a')).toBe('except');
    expect(withRowChecked(excepted, 'ref:a', true).has('ref:a')).toBe(false);
  });

  it('checks or unchecks several keys at once without touching the others', () => {
    const start = withChoice(NONE, 'ref:c', 'except');
    const unchecked = withKeysChecked(start, ['ref:a', 'ref:b'], false);
    expect([...unchecked].sort()).toEqual([
      ['ref:a', 'skip'],
      ['ref:b', 'skip'],
      ['ref:c', 'except'],
    ]);
    expect([...withKeysChecked(unchecked, ['ref:a', 'ref:b'], true)]).toEqual([['ref:c', 'except']]);
  });

  it('never mutates the choices it is given', () => {
    const start: RowChoices = new Map([['ref:a', 'skip']]);
    withRowChecked(start, 'ref:a', true);
    withChoice(start, 'ref:a', 'except');
    withKeysChecked(start, ['ref:z'], false);
    expect([...start]).toEqual([['ref:a', 'skip']]);
  });

  it('drops the choices about keys a fresh answer no longer offers', () => {
    const choices: RowChoices = new Map([
      ['ref:a', 'skip'],
      ['ref:d', 'except'],
      ['ref:gone', 'skip'],
    ]);
    expect([...pruneChoices(choices, ['ref:a', 'ref:b'])]).toEqual([['ref:a', 'skip']]);
  });
});

describe('checkState', () => {
  it('is none, some or all of the keys checked', () => {
    const keys = ['a', 'b', 'c'];
    expect(checkState(keys, () => false)).toBe('none');
    expect(checkState(keys, (k) => k === 'b')).toBe('some');
    expect(checkState(keys, () => true)).toBe('all');
  });

  it('is none for no keys: nothing is checked', () => {
    expect(checkState([], () => true)).toBe('none');
  });
});

describe('payeeTip', () => {
  const payee = (over: Partial<ImportPreviewPayee>): ImportPreviewPayee => ({
    original: 'BIEDRONKA 4711',
    name: 'Biedronka S.A.',
    via: 'alias',
    aliasPattern: 'BIEDRONKA*',
    payeeId: 'p-1',
    ...over,
  });

  it('explains an alias with its pattern', () => {
    expect(payeeTip(payee({}))).toEqual({
      kind: 'alias',
      original: 'BIEDRONKA 4711',
      name: 'Biedronka S.A.',
      pattern: 'BIEDRONKA*',
    });
  });

  it('explains an alias whose pattern could not be found without inventing one', () => {
    expect(payeeTip(payee({ aliasPattern: null }))?.kind).toBe('aliasNoPattern');
  });

  it('explains a payee that will be created and one a rule sets', () => {
    expect(payeeTip(payee({ via: 'new', aliasPattern: null }))?.kind).toBe('new');
    expect(payeeTip(payee({ via: 'rule', aliasPattern: null }))?.kind).toBe('rule');
    expect(payeeTip(payee({ via: 'rule', name: null, aliasPattern: null }))?.kind).toBe('ruleNone');
  });

  it('explains an exact-name match only when the name differs from the source text', () => {
    expect(payeeTip(payee({ via: 'name', original: 'Biedronka', name: 'Biedronka' }))).toBeNull();
    expect(payeeTip(payee({ via: 'name', original: 'biedronka', name: 'Biedronka' }))?.kind).toBe('name');
  });

  it('has nothing to say without a payee, without the source text, or for none', () => {
    expect(payeeTip(null)).toBeNull();
    expect(payeeTip(payee({ original: null }))).toBeNull();
    expect(payeeTip(payee({ via: 'none', name: null }))).toBeNull();
  });
});
