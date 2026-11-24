import { describe, it, expect } from 'vitest';
import { createSearchMatcher, normalizeForSearch, searchIncludes, searchStartsWith } from './search-match';

describe('search-match', () => {
  it('lower-cases and strips punctuation and symbols but keeps spaces', () => {
    expect(normalizeForSearch("Zehr's Supermarket")).toBe('zehrs supermarket');
    expect(normalizeForSearch('AT&T / Wal-Mart.')).toBe('att  walmart');
  });

  it('matches across an apostrophe in the text', () => {
    expect(searchIncludes("Zehr's Supermarket", 'zehrs')).toBe(true);
    expect(searchIncludes("Zehr's Supermarket", 'zehr')).toBe(true);
    expect(searchIncludes("Zehr's Supermarket", 'zehrs super')).toBe(true);
  });

  it('ignores punctuation in the query as well', () => {
    expect(searchIncludes('Zehrs Supermarket', "zehr's")).toBe(true);
    expect(searchIncludes('ATT Wireless', 'AT&T')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(searchIncludes('Zellers', 'zehrs')).toBe(false);
  });

  it('falls back to a literal match when the query is only punctuation', () => {
    expect(searchIncludes('AT&T', '&')).toBe(true);
    expect(searchIncludes('Costco', '&')).toBe(false);
  });

  it('treats a missing text as no match', () => {
    expect(searchIncludes(undefined, 'a')).toBe(false);
    expect(searchStartsWith(null, 'a')).toBe(false);
  });

  it('checks a prefix ignoring punctuation', () => {
    expect(searchStartsWith("Zehr's Supermarket", 'zehrs')).toBe(true);
    expect(searchStartsWith("Zehr's Supermarket", 'super')).toBe(false);
  });

  describe('createSearchMatcher', () => {
    const texts = ["Zehr's Supermarket", 'AT&T', 'Costco', 'ATT Wireless', ''];
    const queries = ['zehrs', "zehr's", '&', 'AT&T', 'super', 'co'];

    it('answers exactly what searchIncludes and searchStartsWith answer, with or without a key', () => {
      for (const query of queries) {
        const match = createSearchMatcher(query);
        for (const text of texts) {
          const key = normalizeForSearch(text);
          expect(match.includes(text)).toBe(searchIncludes(text, query));
          expect(match.includes(text, key)).toBe(searchIncludes(text, query));
          expect(match.startsWith(text)).toBe(searchStartsWith(text, query));
          expect(match.startsWith(text, key)).toBe(searchStartsWith(text, query));
        }
      }
    });

    it('treats a missing text as no match', () => {
      const match = createSearchMatcher('a');
      expect(match.includes(undefined)).toBe(false);
      expect(match.startsWith(null, '')).toBe(false);
    });
  });
});
