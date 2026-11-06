import { FxProviderChain } from "./fx-provider-chain";
import {
  FxObservation,
  FxProviderName,
  FxRateProvider,
} from "./fx-provider.interface";
import { resolveFxProviders } from "./fx-provider.config";

/**
 * A provider double. `carried` is the set of codes it quotes ("all" for one
 * that cannot enumerate, like Yahoo). The label stands in for the name: the
 * `FxProviderName` union is what the parser admits from `FX_PROVIDERS`, and
 * the chain only ever reads the field back in `describe()`.
 */
type ProviderDouble = jest.Mocked<Omit<FxRateProvider, "fetchLive">> & {
  fetchLive?: jest.Mock<Promise<FxObservation | null>, [string, string]>;
};

function provider(
  label: string,
  carried: readonly string[] | "all",
  withLive = false,
): ProviderDouble {
  const double: ProviderDouble = {
    name: label as FxProviderName,
    source: `${label}_source`,
    carries: jest.fn(
      async (code: string) => carried === "all" || carried.includes(code),
    ),
    fetchLatest: jest.fn().mockResolvedValue(null),
    fetchDailySeries: jest.fn().mockResolvedValue(null),
  };
  if (withLive) double.fetchLive = jest.fn().mockResolvedValue(null);
  return double;
}

const obs = (
  from: string,
  to: string,
  date: string,
  rate: number,
): FxObservation => ({ from, to, date, rate });

const P1_SERIES = [
  obs("USD", "CAD", "2024-01-02", 1.3294),
  obs("USD", "CAD", "2024-01-03", 1.3347),
];
const P2_SERIES = [obs("CAD", "USD", "2024-01-02", 0.7522)];

describe("FxProviderChain.dailySeries", () => {
  /**
   * Section 5 of docs/specs/exchange-rate-providers.md, one row each.
   * "not asked" for P2 means P1 settled the window; "no" means the provider
   * carries neither code.
   */
  const rows: Array<{
    row: string;
    p1: { carries: boolean; answer: FxObservation[] | null };
    p2: { carries: boolean; answer: FxObservation[] | null | "not asked" };
    points: FxObservation[];
    answered: boolean;
    carried: boolean;
    source: string | null;
  }> = [
    {
      row: "1: P1 does not carry, P2 answers a series",
      p1: { carries: false, answer: null },
      p2: { carries: true, answer: P2_SERIES },
      points: P2_SERIES,
      answered: true,
      carried: true,
      source: "p2_source",
    },
    {
      row: "2: P1 answers a series, P2 is not asked",
      p1: { carries: true, answer: P1_SERIES },
      p2: { carries: true, answer: "not asked" },
      points: P1_SERIES,
      answered: true,
      carried: true,
      source: "p1_source",
    },
    {
      row: "3: P1 answers nothing, P2 answers a series",
      p1: { carries: true, answer: [] },
      p2: { carries: true, answer: P2_SERIES },
      points: P2_SERIES,
      answered: true,
      carried: true,
      source: "p2_source",
    },
    {
      row: "4: both answer nothing: an empty window, answered",
      p1: { carries: true, answer: [] },
      p2: { carries: true, answer: [] },
      points: [],
      answered: true,
      carried: true,
      source: null,
    },
    {
      row: "5: P1 does not answer, P2 answers a series",
      p1: { carries: true, answer: null },
      p2: { carries: true, answer: P2_SERIES },
      points: P2_SERIES,
      answered: true,
      carried: true,
      source: "p2_source",
    },
    {
      row: "6: P1 does not answer, P2 answers nothing: NOT answered, P1 may hold what P2 does not",
      p1: { carries: true, answer: null },
      p2: { carries: true, answer: [] },
      points: [],
      answered: false,
      carried: true,
      source: null,
    },
    {
      row: "7: neither answers",
      p1: { carries: true, answer: null },
      p2: { carries: true, answer: null },
      points: [],
      answered: false,
      carried: true,
      source: null,
    },
    {
      row: "8: no provider carries the pair: answered, and uncarried",
      p1: { carries: false, answer: null },
      p2: { carries: false, answer: null },
      points: [],
      answered: true,
      carried: false,
      source: null,
    },
  ];

  it.each(rows)(
    "row $row",
    async ({ p1, p2, points, answered, carried, source }) => {
      const first = provider("p1", p1.carries ? ["USD", "CAD"] : []);
      first.fetchDailySeries.mockResolvedValue(p1.answer);
      const second = provider("p2", p2.carries ? ["USD", "CAD"] : []);
      if (p2.answer !== "not asked") {
        second.fetchDailySeries.mockResolvedValue(p2.answer);
      }
      const chain = new FxProviderChain([first, second]);

      const result = await chain.dailySeries(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-05",
      );

      expect(result).toEqual({ points, answered, carried, source });
      if (!p1.carries) expect(first.fetchDailySeries).not.toHaveBeenCalled();
      if (!p2.carries || p2.answer === "not asked") {
        expect(second.fetchDailySeries).not.toHaveBeenCalled();
      }
    },
  );

  it("asks a provider in the window it was given, in order", async () => {
    const first = provider("p1", "all");
    first.fetchDailySeries.mockResolvedValue([]);
    const second = provider("p2", "all");
    second.fetchDailySeries.mockResolvedValue(P2_SERIES);
    const chain = new FxProviderChain([first, second]);

    await chain.dailySeries("USD", "CAD", "2024-01-01", "2024-01-05");

    expect(first.fetchDailySeries).toHaveBeenCalledWith(
      "USD",
      "CAD",
      "2024-01-01",
      "2024-01-05",
    );
    expect(second.fetchDailySeries).toHaveBeenCalledWith(
      "USD",
      "CAD",
      "2024-01-01",
      "2024-01-05",
    );
    const [firstOrder] = first.fetchDailySeries.mock.invocationCallOrder;
    const [secondOrder] = second.fetchDailySeries.mock.invocationCallOrder;
    expect(firstOrder).toBeLessThan(secondOrder);
  });

  it("carrying one code of the pair is not carrying the pair", async () => {
    const only = provider("p1", ["USD"]);
    const chain = new FxProviderChain([only]);

    const result = await chain.dailySeries(
      "USD",
      "CAD",
      "2024-01-01",
      "2024-01-05",
    );

    expect(only.fetchDailySeries).not.toHaveBeenCalled();
    expect(result).toEqual({
      points: [],
      answered: true,
      carried: false,
      source: null,
    });
  });
});

describe("FxProviderChain.latest", () => {
  const latestOf = (...observations: FxObservation[]) =>
    new Map(observations.map((o) => [o.to === "USD" ? o.from : o.to, o]));

  it("takes each quote from the first carrying provider and names its source", async () => {
    const first = provider("p1", ["USD", "CAD", "EUR"]);
    first.fetchLatest.mockResolvedValue(
      latestOf(
        obs("USD", "CAD", "2026-10-07", 1.4253),
        obs("USD", "EUR", "2026-10-07", 0.89469),
      ),
    );
    const second = provider("p2", "all");
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD", "EUR"]);

    expect(first.fetchLatest).toHaveBeenCalledWith("USD", ["CAD", "EUR"]);
    expect(second.fetchLatest).not.toHaveBeenCalled();
    expect(result.found.get("CAD")).toEqual({
      ...obs("USD", "CAD", "2026-10-07", 1.4253),
      source: "p1_source",
    });
    expect(result.found.get("EUR")?.source).toBe("p1_source");
    expect(result.unanswered).toEqual([]);
    expect(result.uncarried).toEqual([]);
  });

  it("a quote absent from the first provider's map moves to the next provider", async () => {
    const first = provider("p1", "all");
    first.fetchLatest.mockResolvedValue(
      latestOf(obs("USD", "CAD", "2026-10-07", 1.4253)),
    );
    const second = provider("p2", "all");
    second.fetchLatest.mockResolvedValue(
      latestOf(obs("TWD", "USD", "2026-10-07", 0.0328)),
    );
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD", "TWD"]);

    expect(second.fetchLatest).toHaveBeenCalledWith("USD", ["TWD"]);
    expect(result.found.get("CAD")?.source).toBe("p1_source");
    // In the orientation the provider answered; the writer orients it.
    expect(result.found.get("TWD")).toEqual({
      ...obs("TWD", "USD", "2026-10-07", 0.0328),
      source: "p2_source",
    });
    expect(result.unanswered).toEqual([]);
  });

  it("a provider that does not answer hands every quote to the next provider", async () => {
    const first = provider("p1", "all");
    first.fetchLatest.mockResolvedValue(null);
    const second = provider("p2", "all");
    second.fetchLatest.mockResolvedValue(
      latestOf(obs("USD", "CAD", "2026-10-07", 1.4253)),
    );
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD"]);

    expect(second.fetchLatest).toHaveBeenCalledWith("USD", ["CAD"]);
    expect(result.found.get("CAD")?.source).toBe("p2_source");
    expect(result.unanswered).toEqual([]);
  });

  it("a quote is unanswered only when every carrying provider returned null", async () => {
    const first = provider("p1", "all");
    first.fetchLatest.mockResolvedValue(null);
    const second = provider("p2", "all");
    second.fetchLatest.mockResolvedValue(null);
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD"]);

    expect(result.found.size).toBe(0);
    expect(result.unanswered).toEqual(["CAD"]);
    expect(result.uncarried).toEqual([]);
  });

  it("one provider answering with nothing is an answer: the quote is neither found nor unanswered", async () => {
    const first = provider("p1", "all");
    first.fetchLatest.mockResolvedValue(null);
    const second = provider("p2", "all");
    second.fetchLatest.mockResolvedValue(new Map());
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD"]);

    expect(result.found.size).toBe(0);
    expect(result.unanswered).toEqual([]);
    expect(result.uncarried).toEqual([]);
  });

  it("an answer with nothing from the first provider is kept when the second does not answer", async () => {
    const first = provider("p1", "all");
    first.fetchLatest.mockResolvedValue(new Map());
    const second = provider("p2", "all");
    second.fetchLatest.mockResolvedValue(null);
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD"]);

    expect(result.unanswered).toEqual([]);
  });

  it("asks a provider only for the quotes it carries, and skips one that does not carry the base", async () => {
    const first = provider("p1", ["USD", "CAD", "EUR"]);
    first.fetchLatest.mockResolvedValue(
      latestOf(
        obs("USD", "CAD", "2026-10-07", 1.4253),
        obs("USD", "EUR", "2026-10-07", 0.89469),
      ),
    );
    const noBase = provider("p2", ["TWD", "CAD"]);
    const third = provider("p3", "all");
    third.fetchLatest.mockResolvedValue(
      latestOf(obs("USD", "TWD", "2026-10-07", 30.5)),
    );
    const chain = new FxProviderChain([first, noBase, third]);

    const result = await chain.latest("USD", ["CAD", "TWD", "EUR"]);

    expect(first.fetchLatest).toHaveBeenCalledWith("USD", ["CAD", "EUR"]);
    expect(noBase.fetchLatest).not.toHaveBeenCalled();
    expect(third.fetchLatest).toHaveBeenCalledWith("USD", ["TWD"]);
    expect([...result.found.keys()].sort()).toEqual(["CAD", "EUR", "TWD"]);
    expect(result.found.get("TWD")?.source).toBe("p3_source");
  });

  it("a quote no configured provider carries is uncarried, and nobody is asked for it", async () => {
    const first = provider("p1", ["USD", "CAD"]);
    first.fetchLatest.mockResolvedValue(
      latestOf(obs("USD", "CAD", "2026-10-07", 1.4253)),
    );
    const second = provider("p2", ["USD", "EUR"]);
    second.fetchLatest.mockResolvedValue(new Map());
    const chain = new FxProviderChain([first, second]);

    const result = await chain.latest("USD", ["CAD", "TWD"]);

    expect(first.fetchLatest).toHaveBeenCalledWith("USD", ["CAD"]);
    expect(second.fetchLatest).not.toHaveBeenCalled();
    expect(result.found.has("TWD")).toBe(false);
    expect(result.unanswered).toEqual([]);
    expect(result.uncarried).toEqual(["TWD"]);
  });

  it("collapses a repeated quote and asks nothing for an empty list", async () => {
    const only = provider("p1", "all");
    only.fetchLatest.mockResolvedValue(
      latestOf(obs("USD", "CAD", "2026-10-07", 1.4253)),
    );
    const chain = new FxProviderChain([only]);

    const repeated = await chain.latest("USD", ["CAD", "CAD"]);
    expect(only.fetchLatest).toHaveBeenCalledWith("USD", ["CAD"]);
    expect(repeated.found.size).toBe(1);

    only.fetchLatest.mockClear();
    const empty = await chain.latest("USD", []);
    expect(only.fetchLatest).not.toHaveBeenCalled();
    expect(empty).toEqual({ found: new Map(), unanswered: [], uncarried: [] });
  });
});

describe("FxProviderChain.live", () => {
  it("answers with the first carrying provider's live quote and does not consult latest", async () => {
    const daily = provider("p1", "all");
    const live = provider("p2", "all", true);
    live.fetchLive!.mockResolvedValue(obs("USD", "CAD", "2026-10-07", 1.4261));
    const chain = new FxProviderChain([daily, live]);

    const result = await chain.live("USD", "CAD");

    expect(live.fetchLive).toHaveBeenCalledWith("USD", "CAD");
    expect(daily.fetchLatest).not.toHaveBeenCalled();
    expect(live.fetchLatest).not.toHaveBeenCalled();
    expect(result).toEqual({
      ...obs("USD", "CAD", "2026-10-07", 1.4261),
      source: "p2_source",
    });
  });

  it("falls back to the chain's latest observation when no live feed answers", async () => {
    const daily = provider("p1", "all");
    daily.fetchLatest.mockResolvedValue(
      new Map([["CAD", obs("USD", "CAD", "2026-10-07", 1.4253)]]),
    );
    const live = provider("p2", "all", true);
    live.fetchLive!.mockResolvedValue(null);
    const chain = new FxProviderChain([daily, live]);

    const result = await chain.live("USD", "CAD");

    expect(live.fetchLive).toHaveBeenCalledWith("USD", "CAD");
    expect(daily.fetchLatest).toHaveBeenCalledWith("USD", ["CAD"]);
    expect(result).toEqual({
      ...obs("USD", "CAD", "2026-10-07", 1.4253),
      source: "p1_source",
    });
  });

  it("does not ask a live feed for a pair it does not carry", async () => {
    const live = provider("p1", ["USD", "EUR"], true);
    const chain = new FxProviderChain([live]);

    const result = await chain.live("USD", "CAD");

    expect(live.fetchLive).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("is null when nothing answers", async () => {
    const live = provider("p1", "all", true);
    const chain = new FxProviderChain([live]);

    expect(await chain.live("USD", "CAD")).toBeNull();
  });
});

describe("FxProviderChain.carriesAny and describe", () => {
  it("carriesAny is whether any configured provider quotes the code", async () => {
    const chain = new FxProviderChain([
      provider("p1", ["USD", "CAD"]),
      provider("p2", ["USD", "EUR"]),
    ]);

    expect(await chain.carriesAny("EUR")).toBe(true);
    expect(await chain.carriesAny("CAD")).toBe(true);
    expect(await chain.carriesAny("TWD")).toBe(false);
    expect(await new FxProviderChain([]).carriesAny("USD")).toBe(false);
  });

  it("describe lists name and source per provider, in configured order", () => {
    const chain = new FxProviderChain([
      provider("p1", "all"),
      provider("p2", "all"),
    ]);

    expect(chain.describe()).toEqual([
      { name: "p1", source: "p1_source" },
      { name: "p2", source: "p2_source" },
    ]);
  });
});

describe("FxProviderChain.verifyCurrency and searchCurrency", () => {
  /** A provider double with the two optional lookup aids. */
  const withLookup = (
    label: string,
    known: boolean | null | "not implemented",
    found: string | null | "not implemented" = "not implemented",
  ) => {
    const double = provider(label, []) as ProviderDouble & {
      verifyCurrency?: jest.Mock<Promise<boolean | null>, [string]>;
      searchCurrency?: jest.Mock<Promise<string | null>, [string]>;
    };
    if (known !== "not implemented") {
      double.verifyCurrency = jest.fn().mockResolvedValue(known);
    }
    if (found !== "not implemented") {
      double.searchCurrency = jest.fn().mockResolvedValue(found);
    }
    return double;
  };

  it.each<[string, Array<boolean | null | "not implemented">, boolean | null]>([
    ["one provider knows the code", [false, true], true],
    ["every verifier answered no", [false, false], false],
    ["a verifier did not answer and none knew it", [false, null], null],
    ["no provider can verify a code", ["not implemented"], null],
    ["no provider is configured", [], null],
    [
      "a provider without the aid is passed over",
      ["not implemented", false],
      false,
    ],
  ])("verifyCurrency: %s", async (_label, answers, expected) => {
    const chain = new FxProviderChain(
      answers.map((known, index) => withLookup(`p${index + 1}`, known)),
    );

    expect(await chain.verifyCurrency("KWD")).toBe(expected);
  });

  it("verifyCurrency stops at the first provider that knows the code", async () => {
    const first = withLookup("p1", true);
    const second = withLookup("p2", true);

    expect(
      await new FxProviderChain([first, second]).verifyCurrency("KWD"),
    ).toBe(true);
    expect(first.verifyCurrency).toHaveBeenCalledWith("KWD");
    expect(second.verifyCurrency).not.toHaveBeenCalled();
  });

  it("searchCurrency answers the first provider's code, in configured order", async () => {
    const without = withLookup("p1", "not implemented");
    const nothing = withLookup("p2", "not implemented", null);
    const found = withLookup("p3", "not implemented", "MYR");
    const later = withLookup("p4", "not implemented", "SGD");

    const chain = new FxProviderChain([without, nothing, found, later]);

    expect(await chain.searchCurrency("Ringgit Malaysia")).toBe("MYR");
    expect(nothing.searchCurrency).toHaveBeenCalledWith("Ringgit Malaysia");
    expect(later.searchCurrency).not.toHaveBeenCalled();
  });

  it("searchCurrency is null when no provider resolves the query", async () => {
    const chain = new FxProviderChain([
      withLookup("p1", "not implemented"),
      withLookup("p2", "not implemented", null),
    ]);

    expect(await chain.searchCurrency("xyz")).toBeNull();
  });
});

/**
 * INV-CRYPTO-002: a pair with a coin on either side is asked of the provider
 * that claims the coin, and only of it; that provider is asked about no other
 * pair, so a fiat provider that cannot enumerate (Yahoo's `carries` is always
 * true) never answers for a coin, and the coin provider never answers, or
 * masks the outage of, a fiat pair. `docs/specs/crypto-accounts.md` decision 5.
 */
describe("FxProviderChain and a provider that claims coins", () => {
  const COINS = ["BTC", "XYZ"];

  /** The crypto adapter's shape: carries the fiat codes and the priced coin BTC, claims every coin. */
  function coinProvider(): ProviderDouble & {
    claims: jest.Mock<Promise<boolean>, [string]>;
  } {
    const double = provider("crypto", ["USD", "CAD", "EUR", "BTC"]);
    return Object.assign(double, {
      claims: jest.fn(async (code: string) => COINS.includes(code)),
    });
  }

  it("asks the coin provider only for the quotes with a coin side, and the fiat provider only for the rest", async () => {
    const fiat = provider("yahoo", "all");
    fiat.fetchLatest.mockResolvedValue(
      new Map([["EUR", obs("CAD", "EUR", "2026-11-05", 0.66)]]),
    );
    const crypto = coinProvider();
    crypto.fetchLatest.mockResolvedValue(
      new Map([["BTC", obs("BTC", "CAD", "2026-11-05", 137000)]]),
    );
    const chain = new FxProviderChain([fiat, crypto]);

    const result = await chain.latest("CAD", ["BTC", "EUR"]);

    expect(fiat.fetchLatest).toHaveBeenCalledWith("CAD", ["EUR"]);
    expect(crypto.fetchLatest).toHaveBeenCalledWith("CAD", ["BTC"]);
    expect(result.found.get("BTC")?.source).toBe("crypto_source");
    expect(result.found.get("EUR")?.source).toBe("yahoo_source");
  });

  it("asks only the coin provider when the base is the coin", async () => {
    const fiat = provider("yahoo", "all");
    const crypto = coinProvider();
    crypto.fetchLatest.mockResolvedValue(new Map());
    const chain = new FxProviderChain([fiat, crypto]);

    await chain.latest("BTC", ["CAD", "EUR"]);

    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(crypto.fetchLatest).toHaveBeenCalledWith("BTC", ["CAD", "EUR"]);
  });

  it("does not let the coin provider answer, or hide the outage of, a fiat pair", async () => {
    const fiat = provider("frankfurter", ["CAD", "EUR"]);
    fiat.fetchLatest.mockResolvedValue(null);
    const crypto = coinProvider();
    crypto.fetchLatest.mockResolvedValue(new Map());
    const chain = new FxProviderChain([fiat, crypto]);

    const result = await chain.latest("CAD", ["EUR"]);

    expect(crypto.fetchLatest).not.toHaveBeenCalled();
    expect(result.unanswered).toEqual(["EUR"]);
  });

  it("reports a coin the coin provider does not carry (no price symbol) as uncarried, asking nobody", async () => {
    const fiat = provider("yahoo", "all");
    const crypto = coinProvider();
    const chain = new FxProviderChain([fiat, crypto]);

    const result = await chain.latest("CAD", ["XYZ"]);

    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(crypto.fetchLatest).not.toHaveBeenCalled();
    expect(result.uncarried).toEqual(["XYZ"]);
  });

  it("a claimed pair its claiming provider does not carry is uncarried in latest and dailySeries, asking nobody", async () => {
    const fiat = provider("yahoo", "all");
    fiat.fetchLatest.mockResolvedValue(
      new Map([["XYZ", obs("CAD", "XYZ", "2026-11-05", 0.5)]]),
    );
    fiat.fetchDailySeries.mockResolvedValue([
      obs("CAD", "XYZ", "2026-11-04", 0.5),
    ]);
    const crypto = coinProvider();
    const chain = new FxProviderChain([fiat, crypto]);

    const latest = await chain.latest("CAD", ["XYZ"]);
    const series = await chain.dailySeries(
      "XYZ",
      "CAD",
      "2026-11-01",
      "2026-11-04",
    );

    expect(latest).toEqual({
      found: new Map(),
      unanswered: [],
      uncarried: ["XYZ"],
    });
    // Answered (nobody failed to answer) but carried by nobody: a caller may
    // not remember the window or record coverage, because mapping a price
    // symbol changes the answer without changing the chain.
    expect(series).toEqual({
      points: [],
      answered: true,
      carried: false,
      source: null,
    });
    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
    expect(crypto.fetchLatest).not.toHaveBeenCalled();
    expect(crypto.fetchDailySeries).not.toHaveBeenCalled();
  });

  it("a coin pair the coin provider did not answer is unanswered, not handed to a fiat provider", async () => {
    const fiat = provider("yahoo", "all");
    const crypto = coinProvider();
    crypto.fetchLatest.mockResolvedValue(null);
    const chain = new FxProviderChain([fiat, crypto]);

    const result = await chain.latest("BTC", ["CAD"]);

    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(result.unanswered).toEqual(["CAD"]);
  });

  it("routes a daily series the same way", async () => {
    const fiat = provider("yahoo", "all");
    fiat.fetchDailySeries.mockResolvedValue([
      obs("CAD", "EUR", "2026-11-04", 0.66),
    ]);
    const crypto = coinProvider();
    crypto.fetchDailySeries.mockResolvedValue([
      obs("BTC", "CAD", "2026-11-04", 137000),
    ]);
    const chain = new FxProviderChain([fiat, crypto]);

    const coin = await chain.dailySeries(
      "CAD",
      "BTC",
      "2026-11-01",
      "2026-11-04",
    );
    const fiatPair = await chain.dailySeries(
      "CAD",
      "EUR",
      "2026-11-01",
      "2026-11-04",
    );

    expect(coin.source).toBe("crypto_source");
    expect(fiatPair.source).toBe("yahoo_source");
    expect(fiat.fetchDailySeries).toHaveBeenCalledTimes(1);
    expect(fiat.fetchDailySeries).toHaveBeenCalledWith(
      "CAD",
      "EUR",
      "2026-11-01",
      "2026-11-04",
    );
    expect(crypto.fetchDailySeries).toHaveBeenCalledTimes(1);
  });

  it("an unanswered coin window is not answered, and no fiat provider is asked", async () => {
    const fiat = provider("yahoo", "all");
    const crypto = coinProvider();
    const chain = new FxProviderChain([fiat, crypto]);

    const result = await chain.dailySeries(
      "BTC",
      "CAD",
      "2026-11-01",
      "2026-11-04",
    );

    expect(result).toEqual({
      points: [],
      answered: false,
      carried: true,
      source: null,
    });
    expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
  });

  it("never asks a fiat live feed for a coin, falling back to the coin provider's latest", async () => {
    const fiat = provider("yahoo", "all", true);
    const crypto = coinProvider();
    crypto.fetchLatest.mockResolvedValue(
      new Map([["CAD", obs("BTC", "CAD", "2026-11-05", 137000)]]),
    );
    const chain = new FxProviderChain([fiat, crypto]);

    const live = await chain.live("BTC", "CAD");

    expect(fiat.fetchLive).not.toHaveBeenCalled();
    expect(live?.source).toBe("crypto_source");
  });

  it("asks nobody about a pair whose claim the coin provider cannot answer, and reports it unanswered", async () => {
    const fiat = provider("yahoo", "all", true);
    fiat.fetchLatest.mockResolvedValue(
      new Map([["BTC", obs("CAD", "BTC", "2026-11-05", 0.0000073)]]),
    );
    fiat.fetchDailySeries.mockResolvedValue([
      obs("CAD", "BTC", "2026-11-04", 0.0000073),
    ]);
    const crypto = coinProvider();
    crypto.claims.mockRejectedValue(new Error("currencies unreadable"));
    const chain = new FxProviderChain([fiat, crypto]);

    const latest = await chain.latest("CAD", ["BTC"]);
    const series = await chain.dailySeries(
      "CAD",
      "BTC",
      "2026-11-01",
      "2026-11-04",
    );
    const live = await chain.live("CAD", "BTC");

    expect(latest).toEqual({
      found: new Map(),
      unanswered: ["BTC"],
      uncarried: [],
    });
    expect(series).toEqual({
      points: [],
      answered: false,
      carried: true,
      source: null,
    });
    expect(live).toBeNull();
    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
    expect(fiat.fetchLive).not.toHaveBeenCalled();
    expect(crypto.fetchLatest).not.toHaveBeenCalled();
  });

  it("a claimed coin pair whose carriage the coin provider cannot answer is unanswered, not handed on", async () => {
    const fiat = provider("yahoo", "all");
    const crypto = coinProvider();
    crypto.carries.mockRejectedValue(new Error("currencies unreadable"));
    const chain = new FxProviderChain([fiat, crypto]);

    const latest = await chain.latest("CAD", ["BTC"]);
    const series = await chain.dailySeries(
      "CAD",
      "BTC",
      "2026-11-01",
      "2026-11-04",
    );

    expect(latest.unanswered).toEqual(["BTC"]);
    expect(latest.uncarried).toEqual([]);
    expect(series.answered).toBe(false);
    expect(fiat.fetchLatest).not.toHaveBeenCalled();
    expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
    expect(crypto.fetchLatest).not.toHaveBeenCalled();
  });

  it("changes nothing for a chain with no claiming provider", async () => {
    const fiat = provider("yahoo", "all");
    fiat.fetchLatest.mockResolvedValue(new Map());
    const chain = new FxProviderChain([fiat]);

    await chain.latest("CAD", ["BTC"]);

    // Without the coin provider a coin is just a code Yahoo is asked about.
    expect(fiat.fetchLatest).toHaveBeenCalledWith("CAD", ["BTC"]);
  });

  it("describe lists the coin provider beside the configured ones, though it is no FX_PROVIDERS token", () => {
    const chain = new FxProviderChain([
      provider("yahoo", "all"),
      coinProvider(),
    ]);

    expect(chain.describe()).toEqual([
      { name: "yahoo", source: "yahoo_source" },
      { name: "crypto", source: "crypto_source" },
    ]);
    expect(() => resolveFxProviders("yahoo,crypto")).toThrow(
      /unknown exchange rate provider "crypto"/,
    );
  });
});
