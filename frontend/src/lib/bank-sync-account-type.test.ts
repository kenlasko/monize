import { describe, it, expect } from 'vitest';
import {
  accountTypeMismatch,
  isBankSyncEligibleAccountType,
  isKnownBankAccountType,
  normalizeBankAccountType,
  suggestedAccountType,
} from './bank-sync-account-type';

describe('normalizeBankAccountType', () => {
  it('trims and upper-cases', () => {
    expect(normalizeBankAccountType(' card ')).toBe('CARD');
  });

  it.each([null, undefined, '', '   '])('is null for %p', (value) => {
    expect(normalizeBankAccountType(value)).toBeNull();
  });
});

describe('isKnownBankAccountType', () => {
  it.each(['CACC', 'CARD', 'SVGS', 'LOAN'])('knows %s', (code) => {
    expect(isKnownBankAccountType(code)).toBe(true);
  });

  it.each([null, 'CASH', 'OTHR', 'card'])('does not know %p', (code) => {
    expect(isKnownBankAccountType(code)).toBe(false);
  });
});

describe('suggestedAccountType (spec section 5a)', () => {
  it.each([
    ['CARD', 'CREDIT_CARD'],
    ['SVGS', 'SAVINGS'],
    ['LOAN', 'LOAN'],
    ['CACC', 'CHEQUING'],
    ['OTHR', 'CHEQUING'],
    ['CASH', 'CHEQUING'],
    ['card', 'CREDIT_CARD'],
    [null, 'CHEQUING'],
    [undefined, 'CHEQUING'],
  ])('maps %p to %p', (bankType, expected) => {
    expect(suggestedAccountType(bankType)).toBe(expected);
  });
});

describe('accountTypeMismatch', () => {
  it('flags a card linked to anything but a credit card', () => {
    expect(accountTypeMismatch('CARD', 'CHEQUING')).toBe('bankCard');
    expect(accountTypeMismatch('CARD', 'SAVINGS')).toBe('bankCard');
    expect(accountTypeMismatch('card', 'LINE_OF_CREDIT')).toBe('bankCard');
  });

  it('flags a credit card linked to a bank account that is not a card', () => {
    expect(accountTypeMismatch('CACC', 'CREDIT_CARD')).toBe('monizeCard');
    expect(accountTypeMismatch('SVGS', 'CREDIT_CARD')).toBe('monizeCard');
    expect(accountTypeMismatch('OTHR', 'CREDIT_CARD')).toBe('monizeCard');
  });

  it('does not flag a card linked to a credit card', () => {
    expect(accountTypeMismatch('CARD', 'CREDIT_CARD')).toBeNull();
  });

  it('does not flag two accounts that are not cards', () => {
    expect(accountTypeMismatch('CACC', 'CHEQUING')).toBeNull();
    expect(accountTypeMismatch('SVGS', 'CHEQUING')).toBeNull();
    expect(accountTypeMismatch('LOAN', 'LOAN')).toBeNull();
  });

  it('makes no claim when the bank did not say what the account is', () => {
    expect(accountTypeMismatch(null, 'CREDIT_CARD')).toBeNull();
    expect(accountTypeMismatch(undefined, 'CHEQUING')).toBeNull();
    expect(accountTypeMismatch('', 'CREDIT_CARD')).toBeNull();
  });

  it('makes no claim when the Monize account is not known', () => {
    expect(accountTypeMismatch('CARD', undefined)).toBeNull();
    expect(accountTypeMismatch('CARD', null)).toBeNull();
  });
});

describe('isBankSyncEligibleAccountType', () => {
  it('refuses a crypto wallet, which no bank feed reports', () => {
    expect(isBankSyncEligibleAccountType('CRYPTO')).toBe(false);
  });

  it('admits the bank-like types', () => {
    for (const type of ['CHEQUING', 'SAVINGS', 'CREDIT_CARD', 'CASH', 'LOAN'] as const) {
      expect(isBankSyncEligibleAccountType(type)).toBe(true);
    }
  });

  it('never suggests CRYPTO for a new account made from a bank account', () => {
    for (const bankType of ['CACC', 'CARD', 'SVGS', 'LOAN', 'OTHR', null]) {
      expect(isBankSyncEligibleAccountType(suggestedAccountType(bankType))).toBe(true);
    }
  });
});
