import { accountNumberMatchesIdentifier } from "./bank-account-identifier";

/**
 * Matching bank accounts to Monize accounts by account number (spec section
 * 5a). Pure: no database, no provider; the service reads both sides and links
 * what this returns.
 *
 * A Monize account is a candidate for a bank account when it is open, not an
 * investment brokerage account, not linked to another bank account, and in the
 * bank account's currency (or the bank account's currency is unknown). It
 * matches when its account number names the bank's identifier
 * (`accountNumberMatchesIdentifier`). Exactly one match links; two or more
 * link nothing and are returned as suggestions.
 */

/** A bank account that is not linked yet. */
export interface MatchableBankAccount {
  id: string;
  /** Normalized; null when the bank account's identifier is not known. */
  accountIdentifier: string | null;
  /** Null when the provider did not say. */
  currencyCode: string | null;
}

/** One of the caller's own Monize accounts. */
export interface MatchableAccount {
  id: string;
  accountNumber: string | null;
  currencyCode: string;
  isClosed: boolean;
  isInvestmentBrokerage: boolean;
}

export interface BankAccountMatches {
  /** The bank account has exactly one candidate, and nothing else claims it. */
  linked: { bankAccountId: string; accountId: string }[];
  /** The bank account has two or more candidates (or shares its only one). */
  suggestions: { bankAccountId: string; accountIds: string[] }[];
}

function isCandidate(
  account: MatchableAccount,
  bank: MatchableBankAccount,
  linkedAccountIds: ReadonlySet<string>,
): boolean {
  if (account.isClosed || account.isInvestmentBrokerage) return false;
  if (linkedAccountIds.has(account.id)) return false;
  if (bank.currencyCode === null) return true;
  return (
    account.currencyCode.trim().toUpperCase() ===
    bank.currencyCode.trim().toUpperCase()
  );
}

/**
 * Compare every bank account with an identifier against the accounts. The
 * output follows the input order of both lists.
 *
 * A Monize account that is the single match of two bank accounts cannot be
 * linked to both (the link is one-to-one), and nothing says which is right, so
 * both are returned as suggestions instead of the first one winning by order.
 */
export function matchBankAccounts(
  bankAccounts: readonly MatchableBankAccount[],
  accounts: readonly MatchableAccount[],
  linkedAccountIds: ReadonlySet<string>,
): BankAccountMatches {
  const candidatesByBank = new Map<string, string[]>();
  for (const bank of bankAccounts) {
    if (bank.accountIdentifier === null) continue;
    const ids = accounts
      .filter(
        (account) =>
          isCandidate(account, bank, linkedAccountIds) &&
          accountNumberMatchesIdentifier(
            account.accountNumber,
            bank.accountIdentifier,
          ),
      )
      .map((account) => account.id);
    if (ids.length > 0) candidatesByBank.set(bank.id, ids);
  }

  const claims = new Map<string, number>();
  for (const ids of candidatesByBank.values()) {
    if (ids.length === 1) claims.set(ids[0], (claims.get(ids[0]) ?? 0) + 1);
  }

  const result: BankAccountMatches = { linked: [], suggestions: [] };
  for (const bank of bankAccounts) {
    const ids = candidatesByBank.get(bank.id);
    if (!ids) continue;
    if (ids.length === 1 && claims.get(ids[0]) === 1) {
      result.linked.push({ bankAccountId: bank.id, accountId: ids[0] });
    } else {
      result.suggestions.push({ bankAccountId: bank.id, accountIds: ids });
    }
  }
  return result;
}
