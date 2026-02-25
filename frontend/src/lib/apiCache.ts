type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL = 30_000; // 30 seconds

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  cache.set(key, { data, timestamp: Date.now(), ttl });
}

export function invalidateCache(keyPrefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(keyPrefix)) {
      cache.delete(key);
    }
  }
}

export function clearAllCache(): void {
  cache.clear();
}
