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
 */
export async function assertAccountCurrencyKindIn(
  m: EntityManager,
  accountType: AccountType | string,
  currencyCode: string,
): Promise<void> {
  const code = String(currencyCode).toUpperCase();
  const row = await m.getRepository(Currency).findOne({
    where: { code },
    select: { code: true, kind: true },
  });
  assertAccountCurrencyKind(accountType, {
    code,
    kind: row?.kind ?? "FIAT",
  });
}
