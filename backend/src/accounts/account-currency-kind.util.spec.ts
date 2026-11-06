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
    const query = jest.fn().mockResolvedValue(row ? [row] : []);
    return {
      manager: { query } as unknown as EntityManager,
      query,
    };
  }

  it("reads the currency row through the caller's manager, by upper-cased code", async () => {
    const { manager, query } = managerWith({ kind: "CRYPTO" });
    await assertAccountCurrencyKindIn(manager, AccountType.CRYPTO, "btc");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(["BTC"]);
  });

  it("reads the kind FOR KEY SHARE, so a concurrent kind change (FOR UPDATE) serializes with the write", async () => {
    const { manager, query } = managerWith({ kind: "FIAT" });
    await assertAccountCurrencyKindIn(manager, AccountType.CHEQUING, "CAD");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/SELECT kind FROM currencies WHERE code = \$1/);
    expect(sql).toMatch(/FOR KEY SHARE\s*$/);
  });

  it("refuses a CHEQUING account in a CRYPTO currency", async () => {
    const { manager } = managerWith({ kind: "CRYPTO" });
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
