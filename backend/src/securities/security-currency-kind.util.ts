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
 */
export async function assertSecurityCurrencyIsFiatIn(
  m: EntityManager,
  currencyCode: string,
): Promise<void> {
  const code = String(currencyCode).toUpperCase();
  const row = await m.getRepository(Currency).findOne({
    where: { code },
    select: { code: true, kind: true },
  });
  assertSecurityCurrencyIsFiat({ code, kind: row?.kind ?? "FIAT" });
}
