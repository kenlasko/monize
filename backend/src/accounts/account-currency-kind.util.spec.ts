import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertAccountCurrencyKind,
  assertAccountCurrencyKindIn,
} from "./account-currency-kind.util";
import { AccountType } from "./entities/account.entity";
import { Currency } from "../currencies/entities/currency.entity";

/** INV-CRYPTO-001: docs/specs/crypto-accounts.md section 5, first table. */
describe("assertAccountCurrencyKind", () => {
  const BTC = { code: "BTC", kind: "CRYPTO" as const };
  const CAD = { code: "CAD", kind: "FIAT" as const };

  it("accepts a CRYPTO account in a CRYPTO currency", () => {
    expect(() =>
      assertAccountCurrencyKind(AccountType.CRYPTO, BTC),
    ).not.toThrow();
  });

  it("refuses a CRYPTO account in a FIAT currency, naming the code, kind and type", () => {
    expect(() => assertAccountCurrencyKind(AccountType.CRYPTO, CAD)).toThrow(
      new BadRequestException(
        "CAD is a FIAT currency, which a CRYPTO account cannot hold. A CRYPTO account holds a cryptocurrency; every other account type holds a fiat currency.",
      ),
    );
  });

  it.each(Object.values(AccountType).filter((t) => t !== AccountType.CRYPTO))(
    "refuses a %s account in a CRYPTO currency",
    (type) => {
      expect(() => assertAccountCurrencyKind(type, BTC)).toThrow(
        BadRequestException,
      );
    },
  );

  it.each(Object.values(AccountType).filter((t) => t !== AccountType.CRYPTO))(
    "accepts a %s account in a FIAT currency",
    (type) => {
      expect(() => assertAccountCurrencyKind(type, CAD)).not.toThrow();
    },
  );

  it("refuses an INVESTMENT account in a CRYPTO currency (track the coin as a security)", () => {
    expect(() =>
      assertAccountCurrencyKind(AccountType.INVESTMENT, BTC),
    ).toThrow(
      "BTC is a CRYPTO currency, which a INVESTMENT account cannot hold.",
    );
  });
});

describe("assertAccountCurrencyKindIn", () => {
  function managerWith(row: Partial<Currency> | null) {
    const findOne = jest.fn().mockResolvedValue(row);
    const getRepository = jest.fn().mockReturnValue({ findOne });
    return {
      manager: { getRepository } as unknown as EntityManager,
      findOne,
      getRepository,
    };
  }

  it("reads the currency row through the caller's manager, by upper-cased code", async () => {
    const { manager, findOne, getRepository } = managerWith({
      code: "BTC",
      kind: "CRYPTO",
    });
    await assertAccountCurrencyKindIn(manager, AccountType.CRYPTO, "btc");
    expect(getRepository).toHaveBeenCalledWith(Currency);
    expect(findOne).toHaveBeenCalledWith({
      where: { code: "BTC" },
      select: { code: true, kind: true },
    });
  });

  it("refuses a CHEQUING account in a CRYPTO currency", async () => {
    const { manager } = managerWith({ code: "BTC", kind: "CRYPTO" });
    await expect(
      assertAccountCurrencyKindIn(manager, AccountType.CHEQUING, "BTC"),
    ).rejects.toThrow(BadRequestException);
  });

  it("treats a code with no row as FIAT: a fiat type passes to the foreign key", async () => {
    const { manager } = managerWith(null);
    await expect(
      assertAccountCurrencyKindIn(manager, AccountType.CHEQUING, "ZZZ"),
    ).resolves.toBeUndefined();
  });

  it("treats a code with no row as FIAT: a CRYPTO type is refused", async () => {
    const { manager } = managerWith(null);
    await expect(
      assertAccountCurrencyKindIn(manager, AccountType.CRYPTO, "ZZZ"),
    ).rejects.toThrow(BadRequestException);
  });
});
