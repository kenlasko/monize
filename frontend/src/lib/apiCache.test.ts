import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCached,
  setCache,
  invalidateCache,
  clearAllCache,
  dedupe,
  invalidateBalanceCaches,
} from './apiCache';
import { readPageSnapshot, writePageSnapshot } from './page-snapshot';

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

describe('invalidateBalanceCaches', () => {
  beforeEach(() => {
    clearAllCache();
  });

  // Every family below is derived from transaction rows, so a money-moving
  // write leaves all of them wrong. Budgets were the omission: a successful
  // expense used to leave `budgets:dashboard` claiming the pre-write remaining
  // amount for up to 30 seconds, and `budgets:cat-status:*` for up to 60.
  it.each([
    'accounts:all:true',
    'accounts:daily-balances:::',
    'investments:portfolioSummary',
    'investments:summary:all',
    'budgets:dashboard',
    'budgets:cat-status:cat-1,cat-2',
    'budgets:all',
    'warranties:list:status=all',
    'payroll-deductions:list',
    'scheduled:all',
  ])('drops %s', (key) => {
    setCache(key, 'stale', 120_000);
    invalidateBalanceCaches();
    expect(getCached(key)).toBeUndefined();
  });

  it('leaves families a transaction cannot change', () => {
    // Renaming a payee or a category is not a money movement, and dropping
    // those lists on every write would turn one mutation into four refetches.
    setCache('payees:all', 'kept', 120_000);
    setCache('categories:all', 'kept', 120_000);
    setCache('institutions:all', 'kept', 120_000);
    invalidateBalanceCaches();
    expect(getCached('payees:all')).toBe('kept');
    expect(getCached('categories:all')).toBe('kept');
    expect(getCached('institutions:all')).toBe('kept');
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

  // Issue #1167 close-out: invalidation racing an in-flight success. A read
  // that started before a mutation must neither be re-served after it nor
  // repopulate the cache with its pre-mutation result when it finally resolves.
  it('invalidation makes an in-flight fetch obsolete and its late result cannot resurrect the cache', async () => {
    let resolveOld!: (val: string) => void;
    let oldStarted = 0;
    const oldFetcher = () => {
      oldStarted++;
      return new Promise<string>(res => { resolveOld = res; });
    };

    // Old fetch starts and is left pending (response not yet on the wire).
    const pOld = dedupe('sched:all', oldFetcher);
    expect(oldStarted).toBe(1);

    // A mutation invalidates the prefix while the old fetch is still in flight.
    invalidateCache('sched:');

    // The next caller must start a NEW request, not join the obsolete one.
    let newStarted = 0;
    const pNew = dedupe('sched:all', () => {
      newStarted++;
      return Promise.resolve('new');
    });
    expect(newStarted).toBe(1);
    expect(pNew).not.toBe(pOld);

    // New fetch resolves first and populates the cache with the fresh value.
    expect(await pNew).toBe('new');
    expect(getCached('sched:all')).toBe('new');

    // Old fetch resolves late -- it must NOT overwrite the fresh cache entry.
    resolveOld('old');
    expect(await pOld).toBe('old'); // its awaiters still get their value
    expect(getCached('sched:all')).toBe('new'); // but the cache is not resurrected

    // A subsequent read is served from the fresh cache without another fetch.
    let thirdStarted = 0;
    const third = await dedupe('sched:all', () => {
      thirdStarted++;
      return Promise.resolve('third');
    });
    expect(third).toBe('new');
    expect(thirdStarted).toBe(0);
  });

  // clearAllCache must give the same guarantee as a prefix invalidation: a
  // fetch already in flight cannot resurrect the cache after the clear.
  it("clearAllCache retires every page's last-drawn data too", () => {
    writePageSnapshot('bills', [{ id: 'st-1' }]);
    clearAllCache();
    expect(readPageSnapshot('bills')).toBeUndefined();
  });

  it("invalidateBalanceCaches leaves the pages' last-drawn data for their refresh to replace", () => {
    writePageSnapshot('accounts', { accounts: [] });
    invalidateBalanceCaches();
    expect(readPageSnapshot('accounts')).toEqual({ accounts: [] });
  });

  it('clearAllCache prevents an in-flight fetch from resurrecting the cache', async () => {
    let resolveOld!: (val: string) => void;
    const pOld = dedupe('k:all', () => new Promise<string>(res => { resolveOld = res; }));

    clearAllCache();

    resolveOld('old');
    expect(await pOld).toBe('old');
    expect(getCached('k:all')).toBeUndefined();
  });

  // The old promise's finally must not evict the replacement request's entry.
  it('a superseded in-flight promise does not evict the replacement on settle', async () => {
    let resolveOld!: (val: string) => void;
    const pOld = dedupe('r:all', () => new Promise<string>(res => { resolveOld = res; }));

    invalidateCache('r:');

    let resolveNew!: (val: string) => void;
    let newStarted = 0;
    const pNew = dedupe('r:all', () => {
      newStarted++;
      return new Promise<string>(res => { resolveNew = res; });
    });
    expect(newStarted).toBe(1);

    // Old settles first -- while the new one is still in flight.
    resolveOld('old');
    await pOld;

    // The new request must still be tracked: a concurrent caller joins it
    // rather than starting a third fetch.
    const pJoin = dedupe('r:all', () => {
      newStarted++;
      return Promise.resolve('third');
    });
    expect(newStarted).toBe(1);
    expect(pJoin).toBe(pNew);

    resolveNew('new');
    expect(await pNew).toBe('new');
    expect(getCached('r:all')).toBe('new');
  });
});
