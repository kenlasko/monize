/**
 * A client-side id: a list key, a removal handle, a temporary row, or the
 * operation id a write carries so a retry is not a second write.
 *
 * `crypto.randomUUID()` exists only in a secure context (HTTPS or localhost).
 * Monize is self-hosted and often served over plain HTTP on a LAN address, where
 * it is `undefined` and a bare call throws -- the split editor's "Add Split"
 * did nothing there (issue #2077). `crypto.getRandomValues` is available in
 * every context, so the fallback builds the same RFC 4122 version 4 UUID from
 * it; both paths draw from the Web Crypto generator, never `Math.random`.
 */
export function newClientId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
