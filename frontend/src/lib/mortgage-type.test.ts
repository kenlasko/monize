import { describe, it, expect } from 'vitest';
import { MORTGAGE_TYPES } from '@/types/account';
import {
  PREPAYMENT_MODES,
  amortizationMethodFor,
  annualizationFor,
  compoundingFor,
  isAcceleratedFrequency,
  mortgageTypeOf,
  prepaymentModeOf,
  storesConstantPayment,
} from '@/lib/mortgage-type';

describe('mortgageTypeOf', () => {
  it('reads the stored type', () => {
    for (const type of MORTGAGE_TYPES) {
      expect(mortgageTypeOf({ mortgageType: type })).toBe(type);
    }
  });
});

describe('trait accessors', () => {
  it('answer from MORTGAGE_TYPE_TRAITS', () => {
    expect(compoundingFor('CANADIAN_FIXED')).toBe('SEMI_ANNUAL');
    expect(compoundingFor('LINEAR')).toBe('NOMINAL');
    expect(amortizationMethodFor('INTEREST_ONLY')).toBe('INTEREST_ONLY');
    expect(annualizationFor('CANADIAN_FIXED')).toBe('SEMI_ANNUAL');
    expect(annualizationFor('ANNUITY')).toBe('DAY_COUNT');
  });
});

describe('prepaymentModeOf', () => {
  it('reads the column, and a null on a LINEAR mortgage as SHORTEN_TERM', () => {
    expect(prepaymentModeOf({ prepaymentMode: 'LOWER_INSTALLMENT' })).toBe('LOWER_INSTALLMENT');
    expect(prepaymentModeOf({ prepaymentMode: null })).toBe('SHORTEN_TERM');
    expect(prepaymentModeOf({})).toBe('SHORTEN_TERM');
  });

  it('lists the two modes the backend CHECK accepts', () => {
    expect(PREPAYMENT_MODES).toEqual(['SHORTEN_TERM', 'LOWER_INSTALLMENT']);
  });
});

describe('storesConstantPayment', () => {
  it('is true for the annuity methods only', () => {
    expect(storesConstantPayment('ANNUITY')).toBe(true);
    expect(storesConstantPayment('CANADIAN_FIXED')).toBe(true);
    expect(storesConstantPayment('LINEAR')).toBe(false);
    expect(storesConstantPayment('INTEREST_ONLY')).toBe(false);
  });
});

describe('isAcceleratedFrequency', () => {
  it('names the two accelerated cadences only', () => {
    expect(isAcceleratedFrequency('ACCELERATED_BIWEEKLY')).toBe(true);
    expect(isAcceleratedFrequency('ACCELERATED_WEEKLY')).toBe(true);
    expect(isAcceleratedFrequency('BIWEEKLY')).toBe(false);
    expect(isAcceleratedFrequency(null)).toBe(false);
  });
});
