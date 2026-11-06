import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import { tr } from "../i18n/translate";

/**
 * A security is priced in a fiat currency (INV-CRYPTO-001,
 * `docs/specs/crypto-accounts.md` decision 8): its `currency_code` is never a
 * CRYPTO currency. A coin held as an investment is a CRYPTO-type security
 * priced through its `<COIN>-<FIAT>` symbol, in that fiat.
 */
export function assertSecurityCurrencyIsFiat(currency: {
  code: string;
  kind: Currency["kind"];
}): void {
  if (currency.kind !== "CRYPTO") return;
  const code = currency.code;
  throw new BadRequestException(
    tr(
      "errors.securities.currencyMustBeFiat",
      `${code} is a cryptocurrency, and a security is priced in a fiat currency. Choose the fiat currency the security is quoted in.`,
      { code },
    ),
  );
}

/**
 * {@link assertSecurityCurrencyIsFiat} for a code, read through the caller's
 * transaction. A code with no `currencies` row is FIAT (the column default).
 *
 * The row is read `FOR KEY SHARE`, as `assertAccountCurrencyKindIn` reads it
 * and as the security row's foreign key locks it anyway, so the kind checked is
 * the kind the write commits against. The kind gate
 * (`CurrenciesService.kindUpdates`) and the delete (`removeWithin`) lock the
 * same row `FOR UPDATE`, which conflicts with it: a read arriving while a kind
 * change holds the row waits for that commit and, under READ COMMITTED,
 * returns the new version; a kind change arriving after this read waits for
 * the security write to commit, and its reference check (a later statement, a
 * fresh snapshot) then sees the security and refuses `kindInUse`.
 *
 * Lock order: the currencies row is the only lock the two paths share. The
 * kind change takes it as its first lock, and what it writes after it (the
 * currency row itself, the creator's `user_currency_preferences` row) no
 * security writer locks, so whatever a security writer locked before this
 * read (a bond recompute's advisory lock, the securities row) the kind change
 * never waits on: no cycle.
 */
export async function assertSecurityCurrencyIsFiatIn(
  m: EntityManager,
  currencyCode: string,
): Promise<void> {
  const code = String(currencyCode).toUpperCase();
  const rows: Array<{ kind: Currency["kind"] }> = await m.query(
    "SELECT kind FROM currencies WHERE code = $1 FOR KEY SHARE",
    [code],
  );
  assertSecurityCurrencyIsFiat({ code, kind: rows[0]?.kind ?? "FIAT" });
}
