import { Logger } from "@nestjs/common";
import { YahooFinanceService } from "../../securities/yahoo-finance.service";
import {
  HistoricalPrice,
  QuoteResult,
} from "../../securities/providers/quote-provider.interface";
import {
  CURRENCY_SEARCH_COUNT,
  FX_FETCH_CONCURRENCY,
  PLACEHOLDER_TOLERANCE,
  REVERSE_FIRST_MEMORY_LIMIT,
  YAHOO_FX_PLACEHOLDER_RATE,
  YahooFxProvider,
} from "./yahoo-fx.provider";

jest.mock("../../common/date-utils", () => ({
  ...jest.requireActual("../../common/date-utils"),
  todayYMD: jest.fn(() => "2026-10-07"),
}));

const TODAY = "2026-10-07";

/** A chart-endpoint quote as `fetchQuoteRaw` builds it; `price` undefined is a 200 without a price. */
const quoteOf = (symbol: string, price: number | undefined): QuoteResult => ({
  symbol,
  regularMarketPrice: price,
  provider: "yahoo",
});

/** One daily bar as `fetchHistoricalWindow` returns it, dated at UTC midnight. */
const bar = (date: string, close: number): HistoricalPrice => ({
  date: new Date(`${date}T00:00:00.000Z`),
  open: null,
  high: null,
  low: null,
  close,
  adjClose: null,
  volume: null,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("YahooFxProvider", () => {
  let yahoo: jest.Mocked<
    Pick<
      YahooFinanceService,
      | "fetchQuote"
      | "fetchQuoteAnswer"
      | "fetchHistoricalWindow"
      | "searchQuotes"
    >
  >;
  let provider: YahooFxProvider;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  /** Answer each symbol from a table; an absent symbol is Yahoo returning null. */
  const quotes = (table: Record<string, QuoteResult | null>) => {
    yahoo.fetchQuote.mockImplementation(
      async (symbol: string) => table[symbol] ?? null,
    );
  };
  const windows = (table: Record<string, HistoricalPrice[] | null>) => {
    yahoo.fetchHistoricalWindow.mockImplementation(
      async (symbol: string) => table[symbol] ?? null,
    );
  };
  const askedSymbols = () => yahoo.fetchQuote.mock.calls.map((c) => c[0]);
  const askedWindows = () =>
    yahoo.fetchHistoricalWindow.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    yahoo = {
      fetchQuote: jest.fn().mockResolvedValue(null),
      fetchQuoteAnswer: jest.fn().mockResolvedValue(null),
      fetchHistoricalWindow: jest.fn().mockResolvedValue(null),
      searchQuotes: jest.fn().mockResolvedValue(null),
    };
    provider = new YahooFxProvider(yahoo as unknown as YahooFinanceService);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it("is the yahoo provider writing yahoo_finance rows, and carries every code", async () => {
    expect(provider.name).toBe("yahoo");
    expect(provider.source).toBe("yahoo_finance");
    expect(await provider.carries("USD")).toBe(true);
    expect(await provider.carries("XYZ")).toBe(true);
  });

  describe("fetchLatest", () => {
    it("asks the direct symbol and dates the quote today, one call for a quote of 1 or more", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4253) });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(askedSymbols()).toEqual(["USDCAD=X"]);
      expect(found).not.toBeNull();
      expect(found!.get("CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4253,
      });
    });

    it("a quote below 1 is checked against the reverse symbol, and the reverse answer comes back in its own orientation", async () => {
      quotes({
        "CADUSD=X": quoteOf("CADUSD=X", 0.7016),
        "USDCAD=X": quoteOf("USDCAD=X", 1.4253),
      });

      const found = await provider.fetchLatest("CAD", ["USD"]);

      expect(askedSymbols()).toEqual(["CADUSD=X", "USDCAD=X"]);
      expect(found!.get("USD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4253,
      });
    });

    it("a direct symbol Yahoo does not answer is followed by the reverse symbol", async () => {
      quotes({ "CADUSD=X": quoteOf("CADUSD=X", 0.7016) });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(askedSymbols()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(found!.get("CAD")).toEqual({
        from: "CAD",
        to: "USD",
        date: TODAY,
        rate: 0.7016,
      });
    });

    it("a null from fetchQuote never becomes an observation: the quote is absent while the batch is answered", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4253) });

      const found = await provider.fetchLatest("USD", ["CAD", "XYZ"]);

      expect(found).not.toBeNull();
      expect(found!.has("XYZ")).toBe(false);
      expect(found!.size).toBe(1);
    });

    it("a batch no symbol answered is no answer, not an empty map", async () => {
      quotes({});

      expect(await provider.fetchLatest("USD", ["CAD", "EUR"])).toBeNull();
      expect(askedSymbols()).toEqual(
        expect.arrayContaining([
          "USDCAD=X",
          "CADUSD=X",
          "USDEUR=X",
          "EURUSD=X",
        ]),
      );
    });

    it("a 200 without a price is an answer: the quote is absent and the batch is answered", async () => {
      quotes({
        "USDCAD=X": quoteOf("USDCAD=X", undefined),
        "CADUSD=X": quoteOf("CADUSD=X", undefined),
      });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(found).not.toBeNull();
      expect(found!.size).toBe(0);
    });

    it("a pair too coarse in both orientations is absent, and named in the log", async () => {
      quotes({
        "IDRSGD=X": quoteOf("IDRSGD=X", 0.0001),
        "SGDIDR=X": quoteOf("SGDIDR=X", 0.0),
      });

      const found = await provider.fetchLatest("IDR", ["SGD"]);

      expect(found).not.toBeNull();
      expect(found!.has("SGD")).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("IDR/SGD"));
    });

    it("an empty quote list asks nothing and answers an empty map", async () => {
      const found = await provider.fetchLatest("USD", []);

      expect(found).toEqual(new Map());
      expect(yahoo.fetchQuote).not.toHaveBeenCalled();
    });

    it(`keeps at most ${FX_FETCH_CONCURRENCY} quote fetches in flight`, async () => {
      const codes = Array.from(
        { length: FX_FETCH_CONCURRENCY + 4 },
        (_, i) => `C${String(i).padStart(2, "0")}`,
      );
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];
      yahoo.fetchQuote.mockImplementation(
        (symbol: string) =>
          new Promise<QuoteResult | null>((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            release.push(() => {
              inFlight -= 1;
              resolve(quoteOf(symbol, 1.5));
            });
          }),
      );

      const pending = provider.fetchLatest("USD", codes);
      await flush();
      expect(inFlight).toBe(FX_FETCH_CONCURRENCY);
      while (release.length > 0) {
        release.shift()!();
        await flush();
      }
      const found = await pending;

      expect(peak).toBe(FX_FETCH_CONCURRENCY);
      expect(found!.size).toBe(codes.length);
    });
  });

  describe("fetchDailySeries", () => {
    const START = "2024-01-01";
    const END = "2024-01-05";
    const DIRECT = [
      bar("2024-01-02", 1.3294),
      bar("2024-01-03", 1.3347),
      bar("2024-01-04", 1.3332),
      bar("2024-01-05", 1.3369),
    ];

    it("asks the direct symbol over the window and answers observations dated by their bar", async () => {
      windows({ "USDCAD=X": DIRECT });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(1);
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledWith(
        "USDCAD=X",
        null,
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-01-05T23:59:59.999Z"),
      );
      expect(series).toEqual([
        { from: "USD", to: "CAD", date: "2024-01-02", rate: 1.3294 },
        { from: "USD", to: "CAD", date: "2024-01-03", rate: 1.3347 },
        { from: "USD", to: "CAD", date: "2024-01-04", rate: 1.3332 },
        { from: "USD", to: "CAD", date: "2024-01-05", rate: 1.3369 },
      ]);
    });

    it("a sparse direct answer is completed by the reverse symbol, densest first, in each one's orientation", async () => {
      const wide = { start: "2024-01-01", end: "2024-01-31" };
      windows({
        "USDCAD=X": [bar("2024-01-02", 1.3294), bar("2024-01-10", 1.33)],
        "CADUSD=X": [
          bar("2024-01-02", 0.7522),
          bar("2024-01-05", 0.75),
          bar("2024-01-15", 0.751),
        ],
      });

      const series = await provider.fetchDailySeries(
        "USD",
        "CAD",
        wide.start,
        wide.end,
      );

      expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(series).toEqual([
        { from: "CAD", to: "USD", date: "2024-01-02", rate: 0.7522 },
        { from: "CAD", to: "USD", date: "2024-01-05", rate: 0.75 },
        { from: "CAD", to: "USD", date: "2024-01-15", rate: 0.751 },
        { from: "USD", to: "CAD", date: "2024-01-10", rate: 1.33 },
      ]);
    });

    it("the direct answer stays first on a tie in density", async () => {
      const wide = { start: "2024-01-01", end: "2024-01-31" };
      windows({
        "USDCAD=X": [bar("2024-01-02", 1.3294)],
        "CADUSD=X": [bar("2024-01-03", 0.7522)],
      });

      const series = await provider.fetchDailySeries(
        "USD",
        "CAD",
        wide.start,
        wide.end,
      );

      expect(series).toEqual([
        { from: "USD", to: "CAD", date: "2024-01-02", rate: 1.3294 },
        { from: "CAD", to: "USD", date: "2024-01-03", rate: 0.7522 },
      ]);
    });

    it("a direct symbol Yahoo does not answer is answered by the reverse one", async () => {
      windows({
        "CADUSD=X": [bar("2024-01-02", 0.7522), bar("2024-01-03", 0.7492)],
      });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(series).toEqual([
        { from: "CAD", to: "USD", date: "2024-01-02", rate: 0.7522 },
        { from: "CAD", to: "USD", date: "2024-01-03", rate: 0.7492 },
      ]);
    });

    it("both symbols answering nothing is an empty window, answered", async () => {
      windows({ "USDCAD=X": [], "CADUSD=X": [] });

      expect(await provider.fetchDailySeries("USD", "CAD", START, END)).toEqual(
        [],
      );
    });

    it.each([
      ["direct silent, reverse empty", { "CADUSD=X": [] }],
      ["direct empty, reverse silent", { "USDCAD=X": [] }],
      ["neither answers", {}],
    ])(
      "nothing found while a symbol did not answer is no answer: %s",
      async (_label, table) => {
        windows(table as Record<string, HistoricalPrice[] | null>);

        expect(
          await provider.fetchDailySeries("USD", "CAD", START, END),
        ).toBeNull();
        expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      },
    );

    it("drops a bar outside the window and a bar without a usable close", async () => {
      windows({
        "USDCAD=X": [
          bar("2023-12-29", 1.3251),
          bar("2024-01-02", 1.3294),
          bar("2024-01-03", 0),
          bar("2024-01-04", Number.NaN),
          bar("2024-01-05", 1.3369),
          bar("2024-01-06", 1.34),
        ],
      });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(series?.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-05"]);
    });
  });

  describe("the placeholder cross-check (issue #1677)", () => {
    const START = "2024-01-01";
    const END = "2024-01-05";

    it("names the placeholder and its 1 % tolerance", () => {
      expect(YAHOO_FX_PLACEHOLDER_RATE).toBe(0.01);
      expect(PLACEHOLDER_TOLERANCE).toBe(0.01);
    });

    it("plan section 7.3: IDRUSD=X at 0.01 against USDIDR=X at 17871 answers the reverse, in its own orientation", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 17871),
      });

      const found = await provider.fetchLatest("IDR", ["USD"]);

      expect(askedSymbols()).toEqual(["IDRUSD=X", "USDIDR=X"]);
      expect(found!.get("USD")).toEqual({
        from: "USD",
        to: "IDR",
        date: TODAY,
        rate: 17871,
      });
      expect(warn).not.toHaveBeenCalled();
      // What this check adds over chooseFxQuote: the placeholder is named.
      expect(log).toHaveBeenCalledWith(expect.stringContaining("IDRUSD=X"));
    });

    it("a placeholder whose reverse is itself too coarse is no rate, never the placeholder", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 0.05),
      });

      const found = await provider.fetchLatest("IDR", ["USD"]);

      expect(found).not.toBeNull();
      expect(found!.has("USD")).toBe(false);
    });

    it("a real rate of 0.01 that its reverse agrees with is not a placeholder: the pair is chosen as before and not remembered", async () => {
      // 1 / 100.5 is 0.995 % from 0.01, inside the tolerance.
      quotes({
        "AAABBB=X": quoteOf("AAABBB=X", 0.01),
        "BBBAAA=X": quoteOf("BBBAAA=X", 100.5),
      });

      const first = await provider.fetchLatest("AAA", ["BBB"]);
      const second = await provider.fetchLatest("AAA", ["BBB"]);

      // chooseFxQuote keeps the side with more digits, as for any quote below 1.
      expect(first!.get("BBB")).toEqual({
        from: "BBB",
        to: "AAA",
        date: TODAY,
        rate: 100.5,
      });
      expect(second).toEqual(first);
      expect(askedSymbols()).toEqual([
        "AAABBB=X",
        "BBBAAA=X",
        "AAABBB=X",
        "BBBAAA=X",
      ]);
      expect(log).not.toHaveBeenCalled();
    });

    it("a placeholder whose reverse does not answer is no rate, with one warn naming the pair", async () => {
      quotes({ "IDRUSD=X": quoteOf("IDRUSD=X", 0.01) });

      const found = await provider.fetchLatest("IDR", ["USD"]);

      expect(found).not.toBeNull();
      expect(found!.has("USD")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("IDR/USD"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("USDIDR=X"));
    });

    it("a placeholder the reverse could not check is not remembered: the next call asks the direct symbol first again", async () => {
      quotes({ "IDRUSD=X": quoteOf("IDRUSD=X", 0.01) });
      await provider.fetchLatest("IDR", ["USD"]);
      yahoo.fetchQuote.mockClear();

      await provider.fetchLatest("IDR", ["USD"]);

      expect(askedSymbols()[0]).toBe("IDRUSD=X");
    });

    it("a remembered pair asks the reverse symbol first on the next fetchLatest and fetchLive, one call each", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 17871),
      });
      await provider.fetchLatest("IDR", ["USD"]);
      yahoo.fetchQuote.mockClear();

      const found = await provider.fetchLatest("IDR", ["USD"]);
      const live = await provider.fetchLive("IDR", "USD");

      expect(askedSymbols()).toEqual(["USDIDR=X", "USDIDR=X"]);
      const expected = { from: "USD", to: "IDR", date: TODAY, rate: 17871 };
      expect(found!.get("USD")).toEqual(expected);
      expect(live).toEqual(expected);
    });

    it("a remembered pair whose reverse goes silent still asks the direct symbol, and the choice is the same rule", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 17871),
      });
      await provider.fetchLatest("IDR", ["USD"]);
      quotes({ "IDRUSD=X": quoteOf("IDRUSD=X", 0.01) });
      yahoo.fetchQuote.mockClear();

      const found = await provider.fetchLatest("IDR", ["USD"]);

      expect(askedSymbols()).toEqual(["USDIDR=X", "IDRUSD=X"]);
      expect(found!.has("USD")).toBe(false);
    });

    it("a remembered pair asks the reverse window first on the next fetchDailySeries, and a dense reverse answer is the whole answer", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 17871),
      });
      await provider.fetchLatest("IDR", ["USD"]);
      windows({
        "USDIDR=X": [
          bar("2024-01-02", 15500),
          bar("2024-01-03", 15520),
          bar("2024-01-04", 15510),
          bar("2024-01-05", 15530),
        ],
      });

      const series = await provider.fetchDailySeries("IDR", "USD", START, END);

      expect(askedWindows()).toEqual(["USDIDR=X"]);
      expect(series).toEqual([
        { from: "USD", to: "IDR", date: "2024-01-02", rate: 15500 },
        { from: "USD", to: "IDR", date: "2024-01-03", rate: 15520 },
        { from: "USD", to: "IDR", date: "2024-01-04", rate: 15510 },
        { from: "USD", to: "IDR", date: "2024-01-05", rate: 15530 },
      ]);
    });

    it("the memory is per question: the reverse question USD->IDR is not affected", async () => {
      quotes({
        "IDRUSD=X": quoteOf("IDRUSD=X", 0.01),
        "USDIDR=X": quoteOf("USDIDR=X", 17871),
      });
      await provider.fetchLatest("IDR", ["USD"]);
      yahoo.fetchQuote.mockClear();

      await provider.fetchLatest("USD", ["IDR"]);

      expect(askedSymbols()).toEqual(["USDIDR=X"]);
    });

    it(`the memory is bounded at ${REVERSE_FIRST_MEMORY_LIMIT} pairs, the oldest forgotten first`, async () => {
      const codes = Array.from(
        { length: REVERSE_FIRST_MEMORY_LIMIT + 1 },
        (_, i) => `Q${String(i).padStart(3, "0")}`,
      );
      yahoo.fetchQuote.mockImplementation(async (symbol: string) =>
        symbol.startsWith("IDR")
          ? quoteOf(symbol, 0.01)
          : quoteOf(symbol, 17871),
      );
      for (const code of codes) {
        await provider.fetchLatest("IDR", [code]);
      }
      yahoo.fetchQuote.mockClear();

      // codes[0] was evicted by the last pair; re-remembering it evicts
      // codes[1], so codes[2] is the oldest pair still remembered.
      await provider.fetchLatest("IDR", [codes[0]]);
      await provider.fetchLatest("IDR", [codes[2]]);

      expect(askedSymbols()).toEqual([
        `IDR${codes[0]}=X`,
        `${codes[0]}IDR=X`,
        `${codes[2]}IDR=X`,
      ]);
    });
  });

  describe("fetchLive", () => {
    it("is the direct quote dated today when it is 1 or more", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4261) });

      expect(await provider.fetchLive("USD", "CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4261,
      });
      expect(askedSymbols()).toEqual(["USDCAD=X"]);
    });

    it("answers the reverse quote in its own orientation when the direct one is silent", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4261) });

      expect(await provider.fetchLive("CAD", "USD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4261,
      });
      expect(askedSymbols()).toEqual(["CADUSD=X", "USDCAD=X"]);
    });

    it("is null when neither symbol answers", async () => {
      quotes({});

      expect(await provider.fetchLive("USD", "CAD")).toBeNull();
    });
  });

  describe("verifyCurrency", () => {
    it("is true when Yahoo answers the code's chart against USD", async () => {
      quotes({ "KWDUSD=X": quoteOf("KWDUSD=X", 3.25) });

      expect(await provider.verifyCurrency("kwd")).toBe(true);
      expect(askedSymbols()).toEqual(["KWDUSD=X"]);
    });

    it("asks USD against EUR rather than against itself", async () => {
      quotes({ "USDEUR=X": quoteOf("USDEUR=X", 0.89) });

      expect(await provider.verifyCurrency("USD")).toBe(true);
      expect(askedSymbols()).toEqual(["USDEUR=X"]);
    });

    it("is no answer, never false, when Yahoo returns null: an outage and an unknown symbol look the same", async () => {
      quotes({});

      expect(await provider.verifyCurrency("XYZ")).toBeNull();
    });
  });

  describe("searchCurrency", () => {
    const search = (
      result: Awaited<ReturnType<YahooFinanceService["searchQuotes"]>>,
    ) => yahoo.searchQuotes.mockResolvedValue(result);

    it("asks Yahoo's search through the client and reads the first FX quote", async () => {
      search([
        { symbol: "MAYBANK.KL", quoteType: "EQUITY" },
        { symbol: "MYRUSD=X", quoteType: "CURRENCY" },
      ]);

      expect(await provider.searchCurrency("Ringgit Malaysia")).toBe("MYR");
      expect(yahoo.searchQuotes).toHaveBeenCalledWith(
        "Ringgit Malaysia",
        CURRENCY_SEARCH_COUNT,
      );
    });

    it("takes the half of the pair the query spells", async () => {
      search([{ symbol: "JPYUSD=X", quoteType: "CURRENCY" }]);
      expect(await provider.searchCurrency("usd")).toBe("USD");

      search([{ symbol: "EURUSD=X", quoteType: "CURRENCY" }]);
      expect(await provider.searchCurrency("EUR")).toBe("EUR");
    });

    it("defaults to the base when neither half is the query", async () => {
      search([{ symbol: "GBPJPY=X", quoteType: "CURRENCY" }]);

      expect(await provider.searchCurrency("some unknown forex")).toBe("GBP");
    });

    it("reads an =X symbol as FX whatever its quoteType", async () => {
      search([{ symbol: "ZARUSD=X", quoteType: "OTHER" }]);

      expect(await provider.searchCurrency("some rand query")).toBe("ZAR");
    });

    it("answers the query upper-cased for a symbol that is not a six-letter pair (carried over unchanged; not an ISO code)", async () => {
      search([{ symbol: "BTC=X", quoteType: "CURRENCY" }]);

      expect(await provider.searchCurrency("btc crypto")).toBe("BTC CRYPTO");
    });

    it.each([
      [
        "no FX quote among the results",
        [{ symbol: "AAPL", quoteType: "EQUITY" }],
      ],
      ["no results", []],
      ["no answer", null],
    ])("is null for %s", async (_label, result) => {
      search(result);

      expect(await provider.searchCurrency("something weird")).toBeNull();
    });
  });

  /**
   * The crypto adapter's doors: a coin pair symbol is passed through as the
   * crypto adapter built it, with none of this adapter's `=X` grammar.
   */
  describe("pair symbol doors", () => {
    it("asks Yahoo for the coin pair's quote as given, keeping absent apart from no answer", async () => {
      const quote = quoteOf("BTC-CAD", 137000);
      yahoo.fetchQuoteAnswer.mockResolvedValueOnce({ quote });
      yahoo.fetchQuoteAnswer.mockResolvedValueOnce({ quote: null });
      yahoo.fetchQuoteAnswer.mockResolvedValueOnce(null);

      expect(await provider.fetchPairSymbolQuote("BTC-CAD")).toEqual({ quote });
      expect(await provider.fetchPairSymbolQuote("NOPE-CAD")).toEqual({
        quote: null,
      });
      expect(await provider.fetchPairSymbolQuote("BTC-EUR")).toBeNull();
      expect(yahoo.fetchQuoteAnswer.mock.calls.map((c) => c[0])).toEqual([
        "BTC-CAD",
        "NOPE-CAD",
        "BTC-EUR",
      ]);
      expect(yahoo.fetchQuote).not.toHaveBeenCalled();
    });

    it("asks the coin pair's daily bars as a coin's listing over the UTC days of the window", async () => {
      const bars = [bar("2026-10-06", 136000)];
      yahoo.fetchHistoricalWindow.mockResolvedValue(bars);

      const answer = await provider.fetchPairSymbolWindow(
        "BTC-CAD",
        "2026-10-01",
        "2026-10-06",
      );

      expect(answer).toBe(bars);
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledWith(
        "BTC-CAD",
        "CRYPTO",
        new Date("2026-10-01T00:00:00.000Z"),
        new Date("2026-10-06T23:59:59.999Z"),
      );
    });
  });
});
