import { describe, it, expect } from 'vitest';
import { commandTerms, daysUntil, matchScore, topMatches } from './command-palette';

describe('commandTerms', () => {
  it('lower-cases, strips accents and splits on whitespace', () => {
    expect(commandTerms('  Café  HYDRO ')).toEqual(['cafe', 'hydro']);
  });

  it('is empty for a blank query', () => {
    expect(commandTerms('   ')).toEqual([]);
  });
});

describe('matchScore', () => {
  it('ranks start of text over start of a word over inside a word', () => {
    const terms = ['hydro'];
    const start = matchScore('Hydro One', terms);
    const word = matchScore('Toronto Hydro', terms);
    const inside = matchScore('Bahydro', terms);
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
  });

  it('needs every term', () => {
    expect(matchScore('Hydro One', ['hydro', 'two'])).toBe(0);
  });

  it('finds accented text from a plain query', () => {
    expect(matchScore('Café Rouge', commandTerms('cafe'))).toBeGreaterThan(0);
  });
});

describe('topMatches', () => {
  const identity = (s: string) => s;

  it('orders by score and honours the limit', () => {
    expect(topMatches(['Toronto Hydro', 'Hydro One', 'Hydro Two'], identity, ['hydro'], 2)).toEqual([
      'Hydro One',
      'Hydro Two',
    ]);
  });

  it('returns nothing without terms', () => {
    expect(topMatches(['Hydro One'], identity, [], 5)).toEqual([]);
  });
});

describe('daysUntil', () => {
  it('counts calendar days across a month end', () => {
    expect(daysUntil('2026-12-02', '2026-11-30')).toBe(2);
  });

  it('is negative for a past date', () => {
    expect(daysUntil('2026-11-08', '2026-11-09')).toBe(-1);
  });

  it('is not moved by a daylight-saving change', () => {
    expect(daysUntil('2026-11-02', '2026-10-31')).toBe(2);
  });
});
