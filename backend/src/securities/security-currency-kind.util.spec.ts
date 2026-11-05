import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertSecurityCurrencyIsFiat,
  assertSecurityCurrencyIsFiatIn,
} from "./security-currency-kind.util";
import { Currency } from "../currencies/entities/currency.entity";

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
  const managerWith = (row: Partial<Currency> | null) =>
    ({
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(row),
      }),
    }) as unknown as EntityManager;

  it("refuses a code whose row is CRYPTO", async () => {
    await expect(
      assertSecurityCurrencyIsFiatIn(
        managerWith({ code: "BTC", kind: "CRYPTO" }),
        "btc",
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts a FIAT row and a code with no row", async () => {
    await expect(
      assertSecurityCurrencyIsFiatIn(
        managerWith({ code: "USD", kind: "FIAT" }),
        "USD",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertSecurityCurrencyIsFiatIn(managerWith(null), "ZZZ"),
    ).resolves.toBeUndefined();
  });
});
