import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import { tr } from "../i18n/translate";
import { AccountType } from "./entities/account.entity";

/** What the comparison needs of a `currencies` row. */
export interface AccountCurrencyKindFacts {
  code: string;
  kind: Currency["kind"];
}

/**
 * INV-CRYPTO-001: an account's type and its currency's kind agree
 * (`docs/specs/crypto-accounts.md` sections 4 and 5). A CRYPTO account holds
 * a CRYPTO currency, and a CRYPTO currency is held only by CRYPTO accounts:
 * every other type, the linked investment pair's halves among them, is FIAT.
 *
 * The one comparison for every writer of an account's type or currency; each
 * calls it inside the transaction that writes the row, before the write.
 */
export function assertAccountCurrencyKind(
  accountType: AccountType | string,
  currency: AccountCurrencyKindFacts,
): void {
  const isCryptoAccount = accountType === AccountType.CRYPTO;
  const isCryptoCurrency = currency.kind === "CRYPTO";
  if (isCryptoAccount === isCryptoCurrency) return;
  const code = currency.code;
  const kind = currency.kind ?? "FIAT";
  throw new BadRequestException(
    tr(
      "errors.accounts.accountCurrencyKindMismatch",
      `${code} is a ${kind} currency, which a ${accountType} account cannot hold. A CRYPTO account holds a cryptocurrency; every other account type holds a fiat currency.`,
      { code, kind, accountType },
    ),
  );
}

/**
 * {@link assertAccountCurrencyKind} for a currency named by its code, read
 * through the caller's transaction. A code with no `currencies` row is FIAT
 * (the column's default): the foreign key refuses the write that follows for a
 * fiat type, and a CRYPTO type is refused here, since an unknown code cannot
 * be a coin.
 *
 * The row is read `FOR KEY SHARE`, the lock the account row's foreign key
 * takes anyway, so the kind checked is the kind the write commits against.
 * The kind gate (`CurrenciesService.kindUpdates`) and the delete
 * (`removeWithin`) lock the same row `FOR UPDATE`, which conflicts with it:
 * a read arriving while a kind change holds the row waits for that commit and,
 * under READ COMMITTED, returns the new version, so it checks the new kind; a
 * kind change arriving after this read waits for the account write to commit,
 * and its reference check (a later statement, a fresh snapshot) then sees the
 * account and refuses `kindInUse`. A plain read would let both commit, a
 * mismatch.
 *
 * Lock order: the currencies row is the only lock the two paths share. The
 * kind change takes it as its first lock, and what it writes after it (the
 * currency row itself, the creator's `user_currency_preferences` row) no
 * account writer locks, so neither can hold something the other waits for
 * while waiting on the currency row: no cycle. Several account writers share
 * `FOR KEY SHARE` without conflict.
 */
export async function assertAccountCurrencyKindIn(
  m: EntityManager,
  accountType: AccountType | string,
  currencyCode: string,
): Promise<void> {
  const code = String(currencyCode).toUpperCase();
  const rows: Array<{ kind: Currency["kind"] }> = await m.query(
    "SELECT kind FROM currencies WHERE code = $1 FOR KEY SHARE",
    [code],
  );
  assertAccountCurrencyKind(accountType, {
    code,
    kind: rows[0]?.kind ?? "FIAT",
  });
}
