import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { bondHoldingValue } from "./bond-holding-value";
import { SecurityValueByAccount } from "./bond-valuation.service";

/** One account's lots: 3 bonds of face value 100, the engine's par 300.00. */
const lotsOf = (marketPriceRequired: boolean): SecurityValueByAccount => ({
  asOf: "2026-10-13",
  accounts: new Map([
    ["acct", { quantity: 3, grossValue: "300.00", marketPriceRequired }],
  ]),
});

/**
 * INV-BOND-005 and INV-BOND-010 for a marketable coupon security: the holding
 * is the person's price times the quantity, never the engine's par. The
 * expected figures are by hand: 101 13/32 = 101.40625, times 3 = 304.21875,
 * which is 304.2188 at the four money places.
 */
describe("bondHoldingValue", () => {
  it("values a holding of a series the engine prices from its own lots", () => {
    expect(bondHoldingValue(lotsOf(false), "acct", 3, 55)).toEqual({
      marketValue: "300.00",
      unitPrice: "100.0000000000",
      basis: "LOTS",
    });
  });

  it("values a marketable holding at the person's price times the quantity, never par", () => {
    expect(bondHoldingValue(lotsOf(true), "acct", 3, 101.40625)).toEqual({
      marketValue: "304.2188",
      unitPrice: "101.4062500000",
      basis: "MARKET_PRICE",
    });
  });

  it("leaves a marketable holding with no price unpriced, not at par and not at zero", () => {
    for (const price of [undefined, null, Number.NaN]) {
      expect(bondHoldingValue(lotsOf(true), "acct", 3, price)).toEqual({
        unpriced: "MARKET_PRICE_MISSING",
      });
    }
  });

  it("does not need the engine's gross value for a marketable holding", () => {
    const valued: SecurityValueByAccount = {
      asOf: "2026-10-13",
      accounts: new Map([
        ["acct", { quantity: 3, grossValue: null, marketPriceRequired: true }],
      ]),
    };
    expect(bondHoldingValue(valued, "acct", 3, 99.5)).toMatchObject({
      marketValue: "298.5000",
    });
  });

  it("leaves a holding unpriced when the lots are unknown or count another quantity", () => {
    expect(bondHoldingValue(null, "acct", 3, 99.5)).toEqual({
      unpriced: "UNKNOWN",
    });
    expect(bondHoldingValue(lotsOf(true), "other", 3, 99.5)).toEqual({
      unpriced: "UNKNOWN",
    });
    expect(bondHoldingValue(lotsOf(true), "acct", 2, 99.5)).toEqual({
      unpriced: "QUANTITY_MISMATCH",
    });
    expect(
      bondHoldingValue(
        {
          asOf: "2026-10-13",
          accounts: new Map([
            [
              "acct",
              { quantity: 3, grossValue: null, marketPriceRequired: false },
            ],
          ]),
        },
        "acct",
        3,
        99.5,
      ),
    ).toEqual({ unpriced: "UNKNOWN" });
  });
});

/**
 * The fix for one surface is not the fix: every file that asks the valuation
 * for an account's lots values the holding through `bondHoldingValue`, so no
 * surface reads the engine's gross value of a traded series as the holding's.
 */
describe("every holdings surface values a bond-linked holding through bondHoldingValue", () => {
  it("fails a file that calls valueByAccount and never bondHoldingValue", () => {
    const files = execFileSync("git", ["ls-files", "src"], {
      cwd: join(__dirname, "..", ".."),
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
    const offenders = files.filter((file) => {
      if (file.endsWith("bonds/bond-valuation.service.ts")) return false;
      const source = readFileSync(join(__dirname, "..", "..", file), "utf8");
      return (
        source.includes("valueByAccount(") &&
        !source.includes("bondHoldingValue(")
      );
    });
    expect(offenders).toEqual([]);
  });
});
