import { describe, it, expect } from 'vitest';
import { commandTerms, daysUntil, highlightFolded, matchScore, topMatches } from './command-palette';

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

describe('highlightFolded', () => {
  it.each([
    ['Hangul, which folds longer', '가게 이름', '가게'],
    ['Devanagari, whose vowel signs fold away', 'किराया', 'किराया'],
    ['a decomposed accent, which folds away', 'cre\u0300me', 'cre\u0300me'],
  ])('marks %s', (_label, text, query) => {
    const marked = highlightFolded(text, commandTerms(query));
    expect(marked.filter((s) => s.match).map((s) => s.text)).toEqual([query]);
    expect(marked.map((s) => s.text).join('')).toBe(text);
  });

  it('marks a word ending in a Greek final sigma', () => {
    expect(highlightFolded('ΟΔΟΣ', commandTerms('οδος'))).toEqual([{ text: 'ΟΔΟΣ', match: true }]);
  });

  it('keeps a dropped mark with its letter', () => {
    expect(highlightFolded('cre\u0300me', commandTerms('cre'))).toEqual([
      { text: 'cre\u0300', match: true },
      { text: 'me', match: false },
    ]);
  });

  it('marks the original characters for a folded term', () => {
    expect(highlightFolded('Café Rouge', commandTerms('cafe'))).toEqual([
      { text: 'Café', match: true },
      { text: ' Rouge', match: false },
    ]);
  });

  it('keeps offsets when a character folds to more than one unit', () => {
    expect(highlightFolded('İstanbul', commandTerms('stan'))).toEqual([
      { text: 'İ', match: false },
      { text: 'stan', match: true },
      { text: 'bul', match: false },
    ]);
  });

  it('leaves text alone without terms', () => {
    expect(highlightFolded('Hydro', [])).toEqual([{ text: 'Hydro', match: false }]);
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
