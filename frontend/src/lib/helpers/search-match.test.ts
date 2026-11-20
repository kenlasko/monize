import { describe, it, expect } from 'vitest';
import { normalizeForSearch, searchIncludes, searchStartsWith } from './search-match';

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
});
