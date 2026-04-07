import { describe, it, expect } from 'vitest';
import { buildSecurityMappings } from './import-matching';
import { Security } from '@/types/investment';

function makeSecurity(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    exchange: 'NASDAQ',
    currencyCode: 'USD',
    isActive: true,
    skipPriceUpdates: false,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

describe('buildSecurityMappings', () => {
  it('matches existing security by symbol', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.' })];
    const result = buildSecurityMappings(new Set(['AAPL']), securities, 'USD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBe('sec-1');
    expect(result[0].currencyCode).toBeUndefined();
  });

  it('matches existing security by name (case-insensitive)', () => {
    const securities = [makeSecurity({ id: 'sec-2', symbol: 'GOOG', name: 'Alphabet Inc.' })];
    const result = buildSecurityMappings(new Set(['alphabet inc.']), securities, 'USD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBe('sec-2');
  });

  it('sets defaultCurrency for unmatched securities', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL' })];
    const result = buildSecurityMappings(new Set(['MSFT']), securities, 'CAD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBeUndefined();
    expect(result[0].currencyCode).toBe('CAD');
  });

  it('does not set currencyCode when security is matched', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL' })];
    const result = buildSecurityMappings(new Set(['AAPL']), securities, 'EUR');

    expect(result[0].securityId).toBe('sec-1');
    expect(result[0].currencyCode).toBeUndefined();
  });

  it('uses undefined currencyCode when no defaultCurrency provided and no match', () => {
    const result = buildSecurityMappings(new Set(['UNKNOWN']), []);

    expect(result[0].currencyCode).toBeUndefined();
  });

  it('handles multiple securities with mixed matches', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.' })];
    const result = buildSecurityMappings(new Set(['AAPL', 'MSFT', 'GOOG']), securities, 'GBP');

    expect(result).toHaveLength(3);
    const matched = result.find((m) => m.originalName === 'AAPL');
    const unmatched1 = result.find((m) => m.originalName === 'MSFT');
    const unmatched2 = result.find((m) => m.originalName === 'GOOG');

    expect(matched!.securityId).toBe('sec-1');
    expect(matched!.currencyCode).toBeUndefined();
    expect(unmatched1!.securityId).toBeUndefined();
    expect(unmatched1!.currencyCode).toBe('GBP');
    expect(unmatched2!.securityId).toBeUndefined();
    expect(unmatched2!.currencyCode).toBe('GBP');
  });

  it('returns empty array for empty input set', () => {
    const result = buildSecurityMappings(new Set(), [], 'USD');
    expect(result).toHaveLength(0);
  });
});
