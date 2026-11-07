import { describe, it, expect } from 'vitest';
import { highlightMatches } from './highlight-matches';

describe('highlightMatches', () => {
  it('returns the whole text unmatched when there are no terms', () => {
    expect(highlightMatches('hello world', [])).toEqual([{ text: 'hello world', match: false }]);
  });

  it('marks one matched term in the middle of the text', () => {
    expect(highlightMatches('Split a transaction', ['transaction'])).toEqual([
      { text: 'Split a ', match: false },
      { text: 'transaction', match: true },
    ]);
  });

  it('matches case-insensitively but preserves the original case in the output', () => {
    expect(highlightMatches('BUDGETS overview', ['budgets'])).toEqual([
      { text: 'BUDGETS', match: true },
      { text: ' overview', match: false },
    ]);
  });

  it('marks every term, in the order they occur in the text', () => {
    expect(highlightMatches('Split a transaction into budgets', ['split', 'budgets'])).toEqual([
      { text: 'Split', match: true },
      { text: ' a transaction into ', match: false },
      { text: 'budgets', match: true },
    ]);
  });

  it('does not double-count overlapping terms: the longer match wins', () => {
    expect(highlightMatches('budgeting', ['budget', 'budgeting'])).toEqual([
      { text: 'budgeting', match: true },
    ]);
  });

  it('ignores an empty term without crashing', () => {
    expect(highlightMatches('hello', [''])).toEqual([{ text: 'hello', match: false }]);
  });

  it('matches nothing when the term is not present', () => {
    expect(highlightMatches('hello world', ['xyz'])).toEqual([
      { text: 'hello world', match: false },
    ]);
  });
});
