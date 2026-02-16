import { describe, it, expect } from 'vitest';
import { optionalUuid, optionalString, optionalNumber } from './zod-helpers';

describe('zod-helpers', () => {
  describe('optionalUuid', () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';

    it('converts empty string to undefined', () => {
      expect(optionalUuid.parse('')).toBeUndefined();
    });

    it('accepts a valid UUID', () => {
      expect(optionalUuid.parse(validUuid)).toBe(validUuid);
    });

    it('accepts undefined', () => {
      expect(optionalUuid.parse(undefined)).toBeUndefined();
    });

    it('rejects an invalid UUID string', () => {
      expect(() => optionalUuid.parse('not-a-uuid')).toThrow();
    });
  });

  describe('optionalString', () => {
    it('converts empty string to undefined', () => {
      expect(optionalString.parse('')).toBeUndefined();
    });

    it('accepts a non-empty string', () => {
      expect(optionalString.parse('hello')).toBe('hello');
    });

    it('accepts undefined', () => {
      expect(optionalString.parse(undefined)).toBeUndefined();
    });
  });

  describe('optionalNumber', () => {
    it('converts empty string to undefined', () => {
      expect(optionalNumber.parse('')).toBeUndefined();
    });

    it('converts null to undefined', () => {
      expect(optionalNumber.parse(null)).toBeUndefined();
    });

    it('converts undefined to undefined', () => {
      expect(optionalNumber.parse(undefined)).toBeUndefined();
    });

    it('accepts a number', () => {
      expect(optionalNumber.parse(42)).toBe(42);
    });

    it('accepts zero', () => {
      expect(optionalNumber.parse(0)).toBe(0);
    });
  });
});
