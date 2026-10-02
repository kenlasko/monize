import { describe, it, expect } from 'vitest';
import { consentDaysToShow, MAX_CONSENT_VALIDITY_DAYS } from './bank-sync-consent';

describe('consentDaysToShow', () => {
  it('is the bank\'s maximum when it is below the 180 days the server requests', () => {
    expect(consentDaysToShow(90)).toBe(90);
    expect(consentDaysToShow(1)).toBe(1);
    expect(consentDaysToShow(179)).toBe(179);
  });

  it('caps a longer maximum at 180, the validity the server asks for', () => {
    expect(MAX_CONSENT_VALIDITY_DAYS).toBe(180);
    expect(consentDaysToShow(180)).toBe(180);
    expect(consentDaysToShow(181)).toBe(180);
    expect(consentDaysToShow(365)).toBe(180);
  });

  it('is whole days', () => {
    expect(consentDaysToShow(90.9)).toBe(90);
    expect(consentDaysToShow(0.4)).toBe(1);
  });

  it.each([null, undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    'claims no length when the bank stated %s',
    (stated) => {
      expect(consentDaysToShow(stated)).toBeNull();
    },
  );
});
