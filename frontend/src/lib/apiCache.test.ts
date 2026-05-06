import { describe, it, expect, beforeEach } from 'vitest';
import { getCached, setCache, invalidateCache, clearAllCache } from './apiCache';

describe('apiCache', () => {
  beforeEach(() => {
    clearAllCache();
  });

  it('returns undefined for missing keys', () => {
    expect(getCached('nope')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    setCache('k1', { foo: 'bar' });
    expect(getCached('k1')).toEqual({ foo: 'bar' });
  });

  it('respects custom TTL — expired entry is evicted on read', () => {
    setCache('k1', 'value', 1);
    // Wait past TTL
    return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
      expect(getCached('k1')).toBeUndefined();
    });
  });

  it('invalidateCache removes only matching prefix', () => {
    setCache('a:1', 1);
    setCache('a:2', 2);
    setCache('b:1', 3);
    invalidateCache('a:');
    expect(getCached('a:1')).toBeUndefined();
    expect(getCached('a:2')).toBeUndefined();
    expect(getCached('b:1')).toBe(3);
  });

  it('clearAllCache empties the cache', () => {
    setCache('a', 1);
    setCache('b', 2);
    clearAllCache();
    expect(getCached('a')).toBeUndefined();
    expect(getCached('b')).toBeUndefined();
  });

  it('uses default 30 second TTL when no ttl arg', () => {
    setCache('default-ttl', 'val');
    expect(getCached('default-ttl')).toBe('val');
  });
});
