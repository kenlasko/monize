import type { AccountType } from '@/types/account';

/**
 * The bank account types a label is written for: `CACC` a current account,
 * `CARD`, `SVGS` savings and `LOAN`. Any other code the bank sends is shown as
 * "Account type {code}" rather than guessed at.
 */
export const KNOWN_BANK_ACCOUNT_TYPES = ['CACC', 'CARD', 'SVGS', 'LOAN'] as const;
export type KnownBankAccountType = (typeof KNOWN_BANK_ACCOUNT_TYPES)[number];

/** The code as the catalog and the comparisons below spell it: trimmed, upper case. */
export function normalizeBankAccountType(code: string | null | undefined): string | null {
  const normalized = code?.trim().toUpperCase();
  return normalized ? normalized : null;
}

export function isKnownBankAccountType(code: string | null): code is KnownBankAccountType {
  return code !== null && (KNOWN_BANK_ACCOUNT_TYPES as readonly string[]).includes(code);
}

/**
 * The Monize account type a new account created from a bank account starts as
 * (spec section 5a): a card is a credit card, savings savings, a loan a loan,
 * and anything else, or nothing stated, a chequing account. The user can change
 * it in the form.
 */
export function suggestedAccountType(bankType: string | null | undefined): AccountType {
  switch (normalizeBankAccountType(bankType)) {
    case 'CARD':
      return 'CREDIT_CARD';
    case 'SVGS':
      return 'SAVINGS';
    case 'LOAN':
      return 'LOAN';
    default:
      return 'CHEQUING';
  }
}

/**
 * Which way a bank account and a Monize account disagree about being a card:
 *
 * - `bankCard`: the bank says CARD and the Monize account is not a credit card;
 * - `monizeCard`: the Monize account is a credit card and the bank says it is
 *   another kind of account;
 * - `null`: they agree, or the bank did not say (an unstated type is no claim,
 *   so it is never a mismatch).
 *
 * A card's rows linked to a chequing account is the mistake this exists to stop.
 */
export type AccountTypeMismatch = 'bankCard' | 'monizeCard';

export function accountTypeMismatch(
  bankType: string | null | undefined,
  monizeType: AccountType | null | undefined,
): AccountTypeMismatch | null {
  const bank = normalizeBankAccountType(bankType);
  if (bank === null || !monizeType) return null;
  if (bank === 'CARD' && monizeType !== 'CREDIT_CARD') return 'bankCard';
  if (bank !== 'CARD' && monizeType === 'CREDIT_CARD') return 'monizeCard';
  return null;
}
