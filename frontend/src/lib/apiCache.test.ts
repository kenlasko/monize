import { describe, it, expect, beforeEach } from 'vitest';
import { getCached, setCache, invalidateCache, clearAllCache, dedupe } from './apiCache';

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

describe('apiCache – dedupe', () => {
  beforeEach(() => {
    clearAllCache();
  });

  it('fetches and caches the value on first call', async () => {
    const fetcher = () => Promise.resolve(42);
    const result = await dedupe('key1', fetcher);
    expect(result).toBe(42);
    expect(getCached('key1')).toBe(42);
  });

  it('returns cached value without calling fetcher again', async () => {
    let callCount = 0;
    const fetcher = () => { callCount++; return Promise.resolve('hello'); };
    await dedupe('key2', fetcher);
    const result = await dedupe('key2', fetcher);
    expect(result).toBe('hello');
    expect(callCount).toBe(1);
  });

  it('deduplicates concurrent in-flight requests (same promise returned)', async () => {
    let resolveIt!: (val: string) => void;
    const fetcher = () => new Promise<string>(res => { resolveIt = res; });

    const p1 = dedupe('key3', fetcher);
    const p2 = dedupe('key3', fetcher);
    expect(p1).toBe(p2);

    resolveIt('done');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('done');
    expect(r2).toBe('done');
  });

  it('does not cache on fetcher rejection', async () => {
    const fetcher = () => Promise.reject(new Error('boom'));
    await expect(dedupe('key4', fetcher)).rejects.toThrow('boom');
    expect(getCached('key4')).toBeUndefined();
  });

  it('removes in-flight entry after rejection so next call re-fetches', async () => {
    let callCount = 0;
    const fetcher = () => {
      callCount++;
      return callCount === 1 ? Promise.reject(new Error('fail')) : Promise.resolve('ok');
    };
    await expect(dedupe('key5', fetcher)).rejects.toThrow('fail');
    const result = await dedupe('key5', fetcher);
    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });

  it('uses custom ttl', async () => {
    await dedupe('key6', () => Promise.resolve('short'), 1);
    await new Promise(res => setTimeout(res, 5));
    expect(getCached('key6')).toBeUndefined();
  });
});
