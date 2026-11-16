import { describe, it, expect } from 'vitest';
import {
  bankDuplicateLists,
  duplicateChoiceOf,
  duplicateOptions,
  pruneDuplicateChoices,
  withDuplicateChoice,
  type DuplicateChoices,
} from './import-duplicates';

describe('duplicateOptions', () => {
  it('offers the allowed actions and the extras in one stable order', () => {
    expect(duplicateOptions(['import', 'merge', 'keep', 'replace'], ['later', 'except'])).toEqual([
      'later',
      'keep',
      'merge',
      'replace',
      'import',
      'except',
    ]);
    expect(duplicateOptions(['keep', 'import'])).toEqual(['keep', 'import']);
  });
});

describe('duplicateChoiceOf', () => {
  const choices: DuplicateChoices = new Map([['a', 'merge']]);

  it('answers the decision, else the default', () => {
    expect(duplicateChoiceOf(choices, 'a', 'later')).toBe('merge');
    expect(duplicateChoiceOf(choices, 'b', 'later')).toBe('later');
  });

  it('falls back when the row no longer offers the decision', () => {
    expect(duplicateChoiceOf(choices, 'a', 'keep', ['keep', 'import'])).toBe('keep');
  });
});

describe('withDuplicateChoice and pruneDuplicateChoices', () => {
  it('records a decision without changing the old map, and forgets keys no longer offered', () => {
    const before: DuplicateChoices = new Map();
    const after = withDuplicateChoice(before, 'a', 'keep');
    expect(before.size).toBe(0);
    expect(after.get('a')).toBe('keep');
    expect(pruneDuplicateChoices(withDuplicateChoice(after, 'b', 'merge'), ['b'])).toEqual(
      new Map([['b', 'merge']]),
    );
  });
});

describe('bankDuplicateLists', () => {
  const all = ['later', 'keep', 'merge', 'replace', 'import', 'except'] as const;

  it('sorts every decision into its list, an undecided row left for later', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => ({ key, options: all }));
    const choices: DuplicateChoices = new Map([
      ['a', 'import'],
      ['b', 'except'],
      ['c', 'merge'],
      ['d', 'keep'],
      ['e', 'replace'],
      ['f', 'later'],
    ]);
    expect(bankDuplicateLists(rows, choices)).toEqual({
      importKeys: ['a'],
      excludeKeys: ['b'],
      mergeKeys: ['c'],
      keepKeys: ['d'],
      replaceKeys: ['e'],
      laterCount: 2,
    });
  });

  it('leaves a decision the row does not offer for later', () => {
    expect(
      bankDuplicateLists([{ key: 'a', options: ['later', 'keep', 'import'] }], new Map([['a', 'replace']])),
    ).toMatchObject({ replaceKeys: [], laterCount: 1 });
  });
});
