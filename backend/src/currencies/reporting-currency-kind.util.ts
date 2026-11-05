import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Currency } from "./entities/currency.entity";
import { tr } from "../i18n/translate";

/**
 * A cryptocurrency is never the reporting currency
 * (`docs/specs/crypto-accounts.md`, decision 11). Every converted figure is
 * `roundMoney` in the reporting currency, at four places, and 0.0001 BTC is
 * about 14 CAD: a net worth, a budget or a report in a coin would round away
 * whole amounts a reader can see.
 *
 * Read through the caller's transaction, before the preference is written, and
 * `FOR KEY SHARE` like the account and security kind checks, so a kind change
 * committing meanwhile is either seen here or refused by its own reference
 * check (`user_preferences.default_currency` is one of the columns
 * `currency_code_referenced_by_data` reads). A code with no `currencies` row
 * is FIAT (the column default).
 */
export async function assertReportingCurrencyIsFiatIn(
  m: EntityManager,
  currencyCode: string,
): Promise<void> {
  const code = String(currencyCode).toUpperCase();
  const rows: Array<{ kind: Currency["kind"] }> = await m.query(
    "SELECT kind FROM currencies WHERE code = $1 FOR KEY SHARE",
    [code],
  );
  if (rows[0]?.kind !== "CRYPTO") return;
  throw new BadRequestException(
    tr(
      "errors.preferences.defaultCurrencyCrypto",
      "A cryptocurrency cannot be the reporting currency",
      { code },
    ),
  );
}
