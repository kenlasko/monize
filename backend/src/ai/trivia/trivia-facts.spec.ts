import { buildTriviaFacts, TriviaFactsInput } from "./trivia-facts";
import type { PortfolioSummary } from "../../securities/portfolio.service";
import type { TriviaFact, TriviaFactId } from "./trivia.types";

const month = (m: string, netWorth: number, assets = netWorth) => ({
  month: m,
  netWorth,
  assets,
  fxComplete: true,
});

const holding = (over: Record<string, unknown>) => ({
  id: "h",
  accountId: "a1",
  securityId: "s1",
  symbol: "XGRO",
  name: "XGRO",
  securityType: "ETF",
  currencyCode: "CAD",
  quantity: 1,
  averageCost: 1,
  costBasis: 100,
  costBasisAccountCurrency: 100,
  currentPrice: 1,
  marketValue: 150,
  marketValueAccountCurrency: 150,
  marketValueDefaultCurrency: 150,
  gainLoss: 50,
  gainLossPercent: 50,
  ...over,
});

const account = (
  accountId: string,
  accountName: string,
  holdings: unknown[],
  currencyCode = "CAD",
) => ({
  accountId,
  accountName,
  currencyCode,
  holdings,
});

function portfolio(over: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalPortfolioValue: 300,
    totalHoldingsValue: 300,
    totalGainLoss: 100,
    totalGainLossPercent: 50,
    gainCostBasis: 200,
    cagr: 7.55,
    valuationComplete: true,
    holdings: [],
    holdingsByAccount: [],
    ...over,
  } as unknown as PortfolioSummary;
}

const input = (over: Partial<TriviaFactsInput>): TriviaFactsInput => ({
  currency: "CAD",
  months: [],
  portfolio: null,
  otherAssets: null,
  portfolioInNetWorth: true,
  ...over,
});

const byId = (facts: TriviaFact[], id: TriviaFactId) =>
  facts.find((f) => f.id === id);

describe("buildTriviaFacts", () => {
  const series = [
    month("2024-11-01", 100),
    month("2024-12-01", 150),
    month("2025-01-01", 120),
    month("2025-02-01", 200),
    month("2025-03-01", 190),
    month("2025-04-01", 195),
    month("2025-05-01", 196),
    month("2025-06-01", 197),
    month("2025-07-01", 198),
    month("2025-08-01", 199),
    month("2025-09-01", 199),
    month("2025-10-01", 199),
    month("2025-11-01", 199),
    month("2025-12-01", 180),
  ];

  it("states the growth since the first month with money", () => {
    const f = byId(
      buildTriviaFacts(input({ months: series })),
      "netWorthSinceStart",
    );
    expect(f?.figures).toEqual({
      startMonth: { kind: "month", value: "2024-11" },
      startAmount: { kind: "money", value: 100, currency: "CAD" },
      startGain: { kind: "money", value: 80, currency: "CAD" },
      startMultiple: { kind: "multiple", value: 1.8 },
    });
  });

  it("says nothing about growth inside a year of history", () => {
    const facts = buildTriviaFacts(input({ months: series.slice(0, 6) }));
    expect(byId(facts, "netWorthSinceStart")).toBeUndefined();
  });

  it("names the largest rise between adjacent months", () => {
    const f = byId(
      buildTriviaFacts(input({ months: series })),
      "netWorthBiggestJump",
    );
    expect(f?.figures.jumpMonth).toEqual({ kind: "month", value: "2025-02" });
    expect(f?.figures.jumpAmount).toEqual({
      kind: "money",
      value: 80,
      currency: "CAD",
    });
  });

  it("does not call a rise across a gap a one-month jump", () => {
    const months = [
      month("2025-01-01", 100),
      month("2025-06-01", 900),
      month("2025-07-01", 910),
    ];
    const f = byId(buildTriviaFacts(input({ months })), "netWorthBiggestJump");
    expect(f?.figures.jumpAmount).toEqual({
      kind: "money",
      value: 10,
      currency: "CAD",
    });
  });

  it("does not count the month a ledger begins as a jump", () => {
    const months = [
      month("2025-01-01", 0),
      month("2025-02-01", 900),
      month("2025-03-01", 910),
    ];
    const f = byId(buildTriviaFacts(input({ months })), "netWorthBiggestJump");
    expect(f?.figures.jumpAmount).toEqual({
      kind: "money",
      value: 10,
      currency: "CAD",
    });
  });

  it("reports the distance below the high point", () => {
    const f = byId(
      buildTriviaFacts(input({ months: series })),
      "netWorthHighPoint",
    );
    expect(f?.figures).toEqual({
      peakAmount: { kind: "money", value: 200, currency: "CAD" },
      peakMonth: { kind: "month", value: "2025-02" },
      peakBelow: { kind: "money", value: 20, currency: "CAD" },
    });
  });

  it("says so when the newest month is the high point", () => {
    const facts = buildTriviaFacts(
      input({ months: [month("2025-01-01", 100), month("2025-02-01", 200)] }),
    );
    expect(byId(facts, "netWorthAtHighPoint")?.figures.currentHigh).toEqual({
      kind: "money",
      value: 200,
      currency: "CAD",
    });
    expect(byId(facts, "netWorthHighPoint")).toBeUndefined();
  });

  it("calls a month level with an earlier high the high point, not $0 below it", () => {
    const facts = buildTriviaFacts(
      input({
        months: [
          month("2025-01-01", 200),
          month("2025-02-01", 100),
          month("2025-03-01", 200),
        ],
      }),
    );
    expect(byId(facts, "netWorthHighPoint")).toBeUndefined();
    expect(byId(facts, "netWorthAtHighPoint")).toBeDefined();
  });

  it("reports an unrecovered dip without a recovery month", () => {
    const facts = buildTriviaFacts(
      input({
        months: [
          month("2025-01-01", 200),
          month("2025-02-01", 100),
          month("2025-03-01", 150),
        ],
      }),
    );
    const dip = byId(facts, "netWorthBiggestDip");
    expect(dip?.figures.dipAmount).toEqual({
      kind: "money",
      value: 100,
      currency: "CAD",
    });
    expect(dip?.figures.dipPercent).toEqual({ kind: "percent", value: 50 });
    expect(dip?.figures.dipRecoveredMonth).toBeUndefined();
  });

  it("names the month a dip was made good", () => {
    const facts = buildTriviaFacts(
      input({
        months: [
          month("2025-01-01", 200),
          month("2025-02-01", 100),
          month("2025-03-01", 205),
        ],
      }),
    );
    expect(
      byId(facts, "netWorthBiggestDipRecovered")?.figures.dipRecoveredMonth,
    ).toEqual({
      kind: "month",
      value: "2025-03",
    });
    expect(byId(facts, "netWorthBiggestDip")).toBeUndefined();
  });

  it("ignores a fall under one percent", () => {
    const facts = buildTriviaFacts(
      input({ months: [month("2025-01-01", 1000), month("2025-02-01", 995)] }),
    );
    expect(byId(facts, "netWorthBiggestDip")).toBeUndefined();
  });

  it("leaves a month that did not convert out of every comparison", () => {
    const months = [
      month("2025-01-01", 100),
      { ...month("2025-02-01", 900000), fxComplete: false },
      month("2025-03-01", 120),
    ];
    const facts = buildTriviaFacts(input({ months }));
    expect(byId(facts, "netWorthHighPoint")).toBeUndefined();
    expect(byId(facts, "netWorthAtHighPoint")?.figures.currentHigh).toEqual({
      kind: "money",
      value: 120,
      currency: "CAD",
    });
  });

  it("says nothing about now when the newest month did not convert", () => {
    const months = [
      month("2024-01-01", 100),
      month("2025-02-01", 150),
      { ...month("2025-03-01", 9000), fxComplete: false },
    ];
    const facts = buildTriviaFacts(input({ months }));
    expect(byId(facts, "netWorthSinceStart")).toBeUndefined();
    expect(byId(facts, "netWorthHighPoint")).toBeUndefined();
    expect(byId(facts, "netWorthAtHighPoint")).toBeUndefined();
  });

  it("returns nothing for fewer than two known months", () => {
    expect(
      buildTriviaFacts(input({ months: [month("2025-01-01", 100)] })),
    ).toEqual([]);
  });

  it("ranks the other assets and shares them of total assets", () => {
    const facts = buildTriviaFacts(
      input({
        months: [
          month("2025-01-01", 100, 1000),
          month("2025-02-01", 100, 1000),
        ],
        otherAssets: [
          { name: "Car", value: 100 },
          { name: "Home", value: 400 },
        ],
      }),
    );
    expect(byId(facts, "netWorthLargestAsset")?.figures).toEqual({
      assetName: { kind: "text", value: "Home" },
      assetValue: { kind: "money", value: 400, currency: "CAD" },
      assetPercent: { kind: "percent", value: 40 },
    });
  });

  it("gives no investment fact over an incomplete valuation", () => {
    const facts = buildTriviaFacts(
      input({
        months: series,
        portfolio: portfolio({ valuationComplete: false }),
      }),
    );
    expect(facts.filter((f) => f.topic === "investments")).toEqual([]);
  });

  it("reads an absent completeness flag as no information, not as incomplete", () => {
    const { valuationComplete: _omitted, ...rest } = portfolio();
    const facts = buildTriviaFacts(
      input({ portfolio: rest as PortfolioSummary }),
    );
    expect(byId(facts, "investmentsGain")).toBeDefined();
  });

  it("does not share a portfolio holding money net worth leaves out", () => {
    const facts = buildTriviaFacts(
      input({
        months: [month("2025-01-01", 100, 100)],
        portfolio: portfolio(),
        portfolioInNetWorth: false,
      }),
    );
    expect(byId(facts, "investmentsShareOfAssets")).toBeUndefined();
    expect(byId(facts, "investmentsGain")).toBeDefined();
  });

  it("shares the portfolio of total assets, as an investments fact", () => {
    const facts = buildTriviaFacts(
      input({
        months: [month("2025-01-01", 100, 600)],
        portfolio: portfolio(),
      }),
    );
    const f = byId(facts, "investmentsShareOfAssets");
    expect(f?.topic).toBe("investments");
    expect(f?.figures.investmentsPercent).toEqual({
      kind: "percent",
      value: 50,
    });
  });

  it("states a gain or a loss, never both", () => {
    const gained = buildTriviaFacts(input({ portfolio: portfolio() }));
    expect(byId(gained, "investmentsGain")?.figures.gainAmount).toEqual({
      kind: "money",
      value: 100,
      currency: "CAD",
    });
    const lost = buildTriviaFacts(
      input({
        portfolio: portfolio({ totalGainLoss: -40, totalGainLossPercent: -20 }),
      }),
    );
    expect(byId(lost, "investmentsGain")).toBeUndefined();
    expect(byId(lost, "investmentsLoss")?.figures.gainPercent).toEqual({
      kind: "percent",
      value: 20,
    });
  });

  it("leaves CAGR out while it is withheld", () => {
    const facts = buildTriviaFacts(
      input({ portfolio: portfolio({ cagr: null }) }),
    );
    expect(byId(facts, "investmentsCagr")).toBeUndefined();
  });

  const twoAccounts = () =>
    portfolio({
      holdingsByAccount: [
        account("a1", "RRSP - Brokerage", [
          holding({ securityId: "s1", symbol: "XGRO", accountId: "a1" }),
          holding({
            securityId: "s2",
            symbol: "VTI",
            accountId: "a1",
            currencyCode: "USD",
            costBasis: 10,
            marketValue: 40,
            marketValueAccountCurrency: 40,
            marketValueDefaultCurrency: 56,
          }),
        ]),
        account("a2", "RESP - Brokerage", [
          holding({ securityId: "s1", symbol: "XGRO", accountId: "a2" }),
        ]),
      ] as never,
    });

  it("sums a security across its accounts and names them", () => {
    const f = byId(
      buildTriviaFacts(input({ portfolio: twoAccounts() })),
      "investmentsBiggestHolding",
    );
    expect(f?.figures).toEqual({
      holdingSymbol: { kind: "text", value: "XGRO" },
      holdingValue: { kind: "money", value: 300, currency: "CAD" },
      holdingPercent: { kind: "percent", value: 100 },
      holdingAccounts: { kind: "text", value: "RESP, RRSP" },
    });
  });

  it("ranks performers in each security's own currency", () => {
    const f = byId(
      buildTriviaFacts(input({ portfolio: twoAccounts() })),
      "investmentsBestPerformer",
    );
    expect(f?.figures).toEqual({
      bestSymbol: { kind: "text", value: "VTI" },
      bestPercent: { kind: "percent", value: 300 },
      bestCost: { kind: "money", value: 10, currency: "USD" },
      bestValue: { kind: "money", value: 40, currency: "USD" },
    });
  });

  it("does not crown a best performer among one security", () => {
    const only = portfolio({
      holdingsByAccount: [account("a1", "RRSP", [holding({})])] as never,
    });
    expect(
      byId(
        buildTriviaFacts(input({ portfolio: only })),
        "investmentsBestPerformer",
      ),
    ).toBeUndefined();
  });

  it("derives a foreign account's rate from its own two totals", () => {
    const usd = portfolio({
      holdingsByAccount: [
        account(
          "a1",
          "US RRSP",
          [
            holding({
              marketValueAccountCurrency: 100,
              marketValueDefaultCurrency: 140.66,
            }),
          ],
          "USD",
        ),
      ] as never,
    });
    const f = byId(
      buildTriviaFacts(input({ portfolio: usd })),
      "investmentsForeignAccount",
    );
    expect(f?.figures.foreignBalance).toEqual({
      kind: "money",
      value: 100,
      currency: "USD",
    });
    expect(f?.figures.foreignConverted).toEqual({
      kind: "money",
      value: 140.66,
      currency: "CAD",
    });
    expect(f?.figures.foreignRate).toEqual({ kind: "rate", value: 1.4066 });
  });

  it("skips an account with an unconverted holding", () => {
    const usd = portfolio({
      holdingsByAccount: [
        account(
          "a1",
          "US",
          [holding({ marketValueDefaultCurrency: null })],
          "USD",
        ),
      ] as never,
    });
    const facts = buildTriviaFacts(input({ portfolio: usd }));
    expect(byId(facts, "investmentsForeignAccount")).toBeUndefined();
    expect(byId(facts, "investmentsBiggestHolding")).toBeUndefined();
  });

  it("names the largest of several accounts, without the brokerage suffix", () => {
    const f = byId(
      buildTriviaFacts(input({ portfolio: twoAccounts() })),
      "investmentsLargestAccount",
    );
    expect(f?.figures).toEqual({
      largestName: { kind: "text", value: "RRSP" },
      largestValue: { kind: "money", value: 206, currency: "CAD" },
    });
  });

  it("does not rank accounts while one of them is unknown", () => {
    const partial = portfolio({
      holdingsByAccount: [
        account("a1", "A", [holding({})]),
        account("a2", "B", [holding({ marketValueDefaultCurrency: null })]),
      ] as never,
    });
    expect(
      byId(
        buildTriviaFacts(input({ portfolio: partial })),
        "investmentsLargestAccount",
      ),
    ).toBeUndefined();
  });
});
