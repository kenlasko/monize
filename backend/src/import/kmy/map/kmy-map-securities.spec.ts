import {
  rawAccount,
  rawFile,
  rawSecurity,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";

function mapSecurities(
  securities: ReturnType<typeof rawSecurity>[],
  coins = new Map<string, number>(),
  held = securities.map((s) => s.id),
) {
  const raw = rawFile({
    accounts: [
      rawAccount({ id: "INV", name: "Broker", type: 7 }),
      ...held.map((id) =>
        rawAccount({
          id: `S-${id}`,
          name: id,
          type: 15,
          parentId: "INV",
          currency: id,
        }),
      ),
      rawAccount({ id: "LOOSE", name: "Loose", type: 15, currency: "ELOOSE" }),
    ],
    securities: [...securities, rawSecurity({ id: "ELOOSE", symbol: "LOS" })],
  });
  return harness(raw, { coinDecimals: coins }).securities;
}

describe("mapKmySecurities (spec 5.8)", () => {
  it("imports the securities an imported holding references, with their type and currency", () => {
    const result = mapSecurities([
      rawSecurity({
        id: "E1",
        name: " Example Corp ",
        symbol: " EXC ",
        type: 0,
      }),
      rawSecurity({
        id: "E2",
        name: "Fund",
        symbol: "FND",
        type: 1,
        tradingCurrency: "EUR",
      }),
      rawSecurity({ id: "E3", name: "Bond", symbol: "BND", type: 2 }),
      rawSecurity({ id: "E4", name: "Other", symbol: "OTH", type: 4 }),
    ]);
    expect(
      result.securities.securities.map((s) => [
        s.handle,
        s.symbol,
        s.name,
        s.currencyCode,
        s.securityType,
        s.skipPriceUpdates,
      ]),
    ).toEqual([
      [1, "EXC", "Example Corp", "USD", "STOCK", false],
      [2, "FND", "Fund", "EUR", "MUTUAL_FUND", false],
      [3, "BND", "Bond", "USD", "BOND", false],
      [4, "OTH", "Other", "USD", null, false],
    ]);
    expect(result.securities.byHandle.get(2)?.symbol).toBe("FND");
    expect(result.byId.get("E3")?.handle).toBe(3);
    expect(result.rawById.get("E1")?.symbol).toBe(" EXC ");
    // One security not held by an imported pair is counted, not imported.
    expect(result.securities.skipped).toBe(1);
    expect(result.securities.warnings).toEqual([]);
  });

  it("makes symbols unique within 20 characters and generates a placeholder for an empty one", () => {
    const result = mapSecurities([
      rawSecurity({ id: "E1", name: "A", symbol: "ABC" }),
      rawSecurity({ id: "E2", name: "B", symbol: "abc" }),
      rawSecurity({ id: "E3", name: "C", symbol: "ABC" }),
      rawSecurity({ id: "E4", name: "D", symbol: "X".repeat(25) }),
      rawSecurity({ id: "E5", name: "Acme Holdings", symbol: " " }),
    ]);
    expect(result.securities.securities.map((s) => s.symbol)).toEqual([
      "ABC",
      "abc-2",
      "ABC-3",
      "X".repeat(20),
      "AH*",
    ]);
    expect(result.securities.securities[4].skipPriceUpdates).toBe(true);
    expect(
      result.securities.warnings.map((w) => [w.code, w.subject, w.detail]),
    ).toEqual([
      ["duplicateSecuritySymbol", "abc", "abc-2"],
      ["duplicateSecuritySymbol", "ABC", "ABC-3"],
      ["generatedSecuritySymbol", "Acme Holdings", "AH*"],
    ]);
  });

  it("resolves a colliding suffix inside the limit", () => {
    const result = mapSecurities([
      rawSecurity({ id: "E1", name: "A", symbol: "X".repeat(20) }),
      rawSecurity({ id: "E2", name: "B", symbol: "X".repeat(20) }),
    ]);
    expect(result.securities.securities[1].symbol).toBe(`${"X".repeat(18)}-2`);
  });

  it("uses the base currency and warns for an empty trading currency", () => {
    const result = mapSecurities([
      rawSecurity({ id: "E1", name: "A", symbol: "A", tradingCurrency: null }),
    ]);
    expect(result.securities.securities[0].currencyCode).toBe("USD");
    expect(result.securities.warnings).toEqual([
      { code: "unknownCurrency", subject: "A", detail: "trading-currency" },
    ]);
  });

  it("does not import a security priced in a CRYPTO currency or a malformed one", () => {
    const result = mapSecurities(
      [
        rawSecurity({
          id: "E1",
          name: "Coin fund",
          symbol: "CF",
          tradingCurrency: "BTC",
        }),
        rawSecurity({
          id: "E2",
          name: "",
          symbol: "",
          tradingCurrency: "usd1",
        }),
      ],
      new Map([["BTC", 8]]),
    );
    expect(result.securities.securities).toHaveLength(0);
    expect(result.securities.warnings).toEqual([
      { code: "securityNotImported", subject: "Coin fund", detail: "BTC" },
      { code: "unsupportedCurrencyCode", subject: "E2", detail: "usd1" },
    ]);
  });

  it("names a security with no name after its symbol", () => {
    const result = mapSecurities([
      rawSecurity({ id: "E1", name: "", symbol: "ZZZ" }),
    ]);
    expect(result.securities.securities[0].name).toBe("ZZZ");
  });
});
