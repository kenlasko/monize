import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertSecurityCurrencyIsFiat,
  assertSecurityCurrencyIsFiatIn,
} from "./security-currency-kind.util";
import { Currency } from "../currencies/entities/currency.entity";
import { CURRENCY_KIND_READ } from "../test-helpers/currency-kind-testing";

describe("assertSecurityCurrencyIsFiat", () => {
  it("accepts a FIAT currency", () => {
    expect(() =>
      assertSecurityCurrencyIsFiat({ code: "USD", kind: "FIAT" }),
    ).not.toThrow();
  });

  it("refuses a CRYPTO currency, naming it", () => {
    expect(() =>
      assertSecurityCurrencyIsFiat({ code: "BTC", kind: "CRYPTO" }),
    ).toThrow(
      new BadRequestException(
        "BTC is a cryptocurrency, and a security is priced in a fiat currency. Choose the fiat currency the security is quoted in.",
      ),
    );
  });
});

describe("assertSecurityCurrencyIsFiatIn", () => {
  const managerWith = (row: Partial<Currency> | null) => {
    const query = jest.fn().mockResolvedValue(row ? [row] : []);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it("reads the kind FOR KEY SHARE through the caller's manager, by upper-cased code", async () => {
    const { manager, query } = managerWith({ kind: "FIAT" });
    await assertSecurityCurrencyIsFiatIn(manager, "usd");
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(CURRENCY_KIND_READ);
    expect(String(sql)).toMatch(/FOR KEY SHARE\s*$/);
    expect(params).toEqual(["USD"]);
  });

  it("refuses a code whose row is CRYPTO", async () => {
    await expect(
      assertSecurityCurrencyIsFiatIn(
        managerWith({ kind: "CRYPTO" }).manager,
        "btc",
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts a FIAT row and a code with no row", async () => {
    await expect(
      assertSecurityCurrencyIsFiatIn(
        managerWith({ kind: "FIAT" }).manager,
        "USD",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertSecurityCurrencyIsFiatIn(managerWith(null).manager, "ZZZ"),
    ).resolves.toBeUndefined();
  });
});
