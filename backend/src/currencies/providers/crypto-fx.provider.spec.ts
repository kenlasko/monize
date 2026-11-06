import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { HistoricalPrice } from "../../securities/providers/quote-provider.interface";
import { YahooQuoteResult } from "../../securities/yahoo-finance.service";
import { Currency } from "../entities/currency.entity";
import {
  CRYPTO_CURRENCY_CACHE_MS,
  CRYPTO_MISS_RELOAD_MS,
  CryptoFxProvider,
} from "./crypto-fx.provider";
import { FxProviderChain } from "./fx-provider-chain";
import { YahooFxProvider } from "./yahoo-fx.provider";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

type YahooDouble = jest.Mocked<
  Pick<YahooFxProvider, "fetchPairSymbolQuote" | "fetchPairSymbolWindow">
>;

/** The rows `currencies` holds for the suite: two fiat, two priced coins, one unpriced. */
const CURRENCY_ROWS: Array<Pick<Currency, "code" | "kind" | "quoteSymbol">> = [
  { code: "CAD", kind: "FIAT", quoteSymbol: null },
  { code: "EUR", kind: "FIAT", quoteSymbol: null },
  { code: "BTC", kind: "CRYPTO", quoteSymbol: "BTC-CAD" },
  // A coin whose Yahoo ticker is longer than its three-letter Monize code.
  { code: "DOG", kind: "CRYPTO", quoteSymbol: "DOGE-USD" },
  { code: "XYZ", kind: "CRYPTO", quoteSymbol: null },
];

/** 2026-11-05T14:30:00Z */
const QUOTE_TIME = Date.UTC(2026, 10, 5, 14, 30) / 1000;

const quote = (
  price: number | undefined,
  time: number | undefined = QUOTE_TIME,
): { quote: YahooQuoteResult } => ({
  quote: {
    symbol: "X",
    regularMarketPrice: price,
    regularMarketTime: time,
    provider: "yahoo",
  } as YahooQuoteResult,
});

const bar = (date: string, close: number): HistoricalPrice => ({
  date: new Date(`${date}T00:00:00.000Z`),
  open: null,
  high: null,
  low: null,
  close,
  adjClose: null,
  volume: null,
});

describe("CryptoFxProvider", () => {
  let currencyRepo: Record<string, jest.Mock>;
  let yahoo: YahooDouble;
  let provider: CryptoFxProvider;

  beforeEach(() => {
    currencyRepo = { find: jest.fn().mockResolvedValue(CURRENCY_ROWS) };
    const { dataSource } = createScopedDbMocks([[Currency, currencyRepo]]);
    yahoo = {
      fetchPairSymbolQuote: jest.fn().mockResolvedValue(null),
      fetchPairSymbolWindow: jest.fn().mockResolvedValue(null),
    };
    provider = new CryptoFxProvider(
      dataSource as never,
      yahoo as unknown as YahooFxProvider,
    );
  });

  afterEach(() => jest.useRealTimers());

  it("names itself crypto and writes the yahoo_crypto slug", () => {
    expect(provider.name).toBe("crypto");
    expect(provider.source).toBe("yahoo_crypto");
  });

  describe("carries and claims", () => {
    it("carries a priced coin and every fiat code, not an unpriced coin", async () => {
      expect(await provider.carries("BTC")).toBe(true);
      expect(await provider.carries("DOG")).toBe(true);
      expect(await provider.carries("CAD")).toBe(true);
      expect(await provider.carries("eur")).toBe(true);
      expect(await provider.carries("XYZ")).toBe(false);
    });

    it("claims every coin, priced or not, and no fiat code", async () => {
      expect(await provider.claims("BTC")).toBe(true);
      expect(await provider.claims("XYZ")).toBe(true);
      expect(await provider.claims("CAD")).toBe(false);
    });

    /**
     * Every code the chain is asked about has a `currencies` row (the foreign
     * keys), so a code the read does not hold means the read is stale, not
     * that the code is fiat: "not mine" would route a coin created on another
     * replica to Yahoo's `=X` grammar until the throttle allows a re-read.
     */
    it("rejects claims and carries for a code the read does not hold, never answering false", async () => {
      await expect(provider.claims("QQQ")).rejects.toThrow(
        "Could not say whether QQQ is a coin",
      );
      await expect(provider.carries("QQQ")).rejects.toThrow(
        "Could not say whether QQQ is a coin",
      );
    });

    it("reads currencies once while the cache is fresh, again after it expires or is forgotten", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
      await provider.carries("BTC");
      await provider.claims("CAD");
      expect(currencyRepo.find).toHaveBeenCalledTimes(1);
      expect(currencyRepo.find).toHaveBeenCalledWith({
        select: { code: true, kind: true, quoteSymbol: true },
      });

      jest.setSystemTime(Date.now() + CRYPTO_CURRENCY_CACHE_MS + 1);
      await provider.carries("BTC");
      expect(currencyRepo.find).toHaveBeenCalledTimes(2);

      provider.forgetCurrencies();
      await provider.carries("BTC");
      expect(currencyRepo.find).toHaveBeenCalledTimes(3);
    });

    it("shares one read between concurrent questions", async () => {
      await Promise.all([
        provider.carries("BTC"),
        provider.carries("CAD"),
        provider.claims("XYZ"),
      ]);
      expect(currencyRepo.find).toHaveBeenCalledTimes(1);
    });

    /**
     * A coin created on another replica, or written by a restore, is not in a
     * snapshot read before it existed, and no local `forgetCurrencies` reached
     * this process. Answering "not mine" for it would leave the coin
     * unclaimed and route it to Yahoo's `=X` grammar (INV-CRYPTO-002).
     */
    it("re-reads currencies once for a code the snapshot does not hold, then answers from the fresh read", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
      const withoutBtc = CURRENCY_ROWS.filter((row) => row.code !== "BTC");
      currencyRepo.find
        .mockResolvedValueOnce(withoutBtc)
        .mockResolvedValue(CURRENCY_ROWS);
      expect(await provider.claims("CAD")).toBe(false);
      expect(currencyRepo.find).toHaveBeenCalledTimes(1);

      jest.setSystemTime(Date.now() + CRYPTO_MISS_RELOAD_MS + 1);
      expect(await provider.claims("BTC")).toBe(true);
      expect(await provider.carries("BTC")).toBe(true);
      expect(currencyRepo.find).toHaveBeenCalledTimes(2);
    });

    it("re-reads for a missing code at most once per throttle window", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
      await provider.claims("CAD");
      expect(currencyRepo.find).toHaveBeenCalledTimes(1);

      // Inside the window: the snapshot is too new to re-read for a miss, and
      // the code is not one it can speak for.
      await expect(provider.claims("QQQ")).rejects.toThrow("Could not say");
      expect(currencyRepo.find).toHaveBeenCalledTimes(1);

      // Past it: one re-read; QQQ still has no row, and the next misses inside
      // the new window cost nothing.
      jest.setSystemTime(Date.now() + CRYPTO_MISS_RELOAD_MS + 1);
      await expect(provider.claims("QQQ")).rejects.toThrow("Could not say");
      await expect(provider.carries("QQQ")).rejects.toThrow("Could not say");
      await expect(provider.claims("QQQ")).rejects.toThrow("Could not say");
      expect(currencyRepo.find).toHaveBeenCalledTimes(2);

      // A known code never re-reads, whatever the time inside the cache.
      jest.setSystemTime(Date.now() + CRYPTO_MISS_RELOAD_MS + 1);
      expect(await provider.claims("BTC")).toBe(true);
      expect(currencyRepo.find).toHaveBeenCalledTimes(2);
    });

    it("rejects claims and carries after a failed read, never answering false, and does not remember the failure", async () => {
      currencyRepo.find
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockRejectedValueOnce(new Error("connection reset"));

      await expect(provider.claims("BTC")).rejects.toThrow("connection reset");
      await expect(provider.carries("BTC")).rejects.toThrow("connection reset");
      expect(await provider.claims("BTC")).toBe(true);
      expect(currencyRepo.find).toHaveBeenCalledTimes(3);
    });
  });

  describe("fetchLatest", () => {
    it("prices a coin base against a fiat quote through <coin>-<fiat>, from the coin to the fiat", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(137250.12));

      const answer = await provider.fetchLatest("BTC", ["CAD"]);

      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledWith("BTC-CAD");
      expect(answer).toEqual(
        new Map([
          [
            "CAD",
            { from: "BTC", to: "CAD", date: "2026-11-05", rate: 137250.12 },
          ],
        ]),
      );
    });

    it("prices a fiat base against a coin quote with the coin as `from`", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(91000));

      const answer = await provider.fetchLatest("EUR", ["BTC"]);

      // BTC is mapped to BTC-CAD, but the pair names EUR, so EUR is asked.
      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledWith("BTC-EUR");
      expect(answer?.get("BTC")).toEqual({
        from: "BTC",
        to: "EUR",
        date: "2026-11-05",
        rate: 91000,
      });
    });

    it("uses the coin ticker of the price symbol, not the Monize code", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(0.25));

      const answer = await provider.fetchLatest("CAD", ["DOG"]);

      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledWith("DOGE-CAD");
      expect(answer?.get("DOG")).toMatchObject({ from: "DOG", to: "CAD" });
    });

    it("asks a pair of two coins once, as <coinA>-<coinB>", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(400000));

      const answer = await provider.fetchLatest("BTC", ["DOG"]);

      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledTimes(1);
      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledWith("BTC-DOGE");
      expect(answer?.get("DOG")).toMatchObject({
        from: "BTC",
        to: "DOG",
        rate: 400000,
      });
    });

    it("dates the quote by the UTC day of its market time", async () => {
      // 22:30 in Toronto on the 4th is already the 5th in UTC.
      yahoo.fetchPairSymbolQuote.mockResolvedValue(
        quote(137000, Date.UTC(2026, 10, 5, 3, 30) / 1000),
      );

      const answer = await provider.fetchLatest("BTC", ["CAD"]);

      expect(answer?.get("CAD")?.date).toBe("2026-11-05");
    });

    it("dates a quote without a market time by today's UTC day", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-07T01:00:00Z") });
      yahoo.fetchPairSymbolQuote.mockResolvedValue(
        quote(137000, null as unknown as number),
      );

      const answer = await provider.fetchLatest("BTC", ["CAD"]);

      expect(answer?.get("CAD")?.date).toBe("2026-11-07");
    });

    it("is null when Yahoo did not answer any symbol", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue(null);

      expect(await provider.fetchLatest("BTC", ["CAD", "EUR"])).toBeNull();
    });

    it("is an empty answer when Yahoo reports the symbol not found (INV-FX-005)", async () => {
      yahoo.fetchPairSymbolQuote.mockResolvedValue({ quote: null });

      const answer = await provider.fetchLatest("BTC", ["CAD"]);

      expect(answer).not.toBeNull();
      expect(answer?.size).toBe(0);
    });

    it.each([undefined, 0, -1, Number.NaN])(
      "answers without a rate for a quote priced %p",
      async (price) => {
        yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(price));

        const answer = await provider.fetchLatest("BTC", ["CAD"]);

        expect(answer).toEqual(new Map());
      },
    );

    it("keeps the quotes that answered when another symbol did not", async () => {
      yahoo.fetchPairSymbolQuote.mockImplementation(async (symbol) =>
        symbol === "BTC-CAD" ? quote(137000) : null,
      );

      const answer = await provider.fetchLatest("BTC", ["CAD", "EUR"]);

      expect([...(answer?.keys() ?? [])]).toEqual(["CAD"]);
    });

    it("asks nothing for a pair it does not price: two fiat codes, or an unpriced coin", async () => {
      const answer = await provider.fetchLatest("CAD", ["EUR", "XYZ"]);

      expect(yahoo.fetchPairSymbolQuote).not.toHaveBeenCalled();
      expect(answer).toEqual(new Map());
    });
  });

  describe("fetchDailySeries", () => {
    it("asks the same symbol over the window and orients each bar from the coin", async () => {
      yahoo.fetchPairSymbolWindow.mockResolvedValue([
        bar("2026-10-31", 136000),
        bar("2026-11-01", 136500),
      ]);

      const series = await provider.fetchDailySeries(
        "CAD",
        "BTC",
        "2026-10-31",
        "2026-11-01",
      );

      expect(yahoo.fetchPairSymbolWindow).toHaveBeenCalledWith(
        "BTC-CAD",
        "2026-10-31",
        "2026-11-01",
      );
      expect(series).toEqual([
        { from: "BTC", to: "CAD", date: "2026-10-31", rate: 136000 },
        { from: "BTC", to: "CAD", date: "2026-11-01", rate: 136500 },
      ]);
    });

    it("drops a bar outside the window or without a usable close", async () => {
      yahoo.fetchPairSymbolWindow.mockResolvedValue([
        bar("2026-10-30", 135000),
        bar("2026-10-31", 0),
        bar("2026-11-01", 136500),
      ]);

      const series = await provider.fetchDailySeries(
        "BTC",
        "EUR",
        "2026-10-31",
        "2026-11-01",
      );

      expect(yahoo.fetchPairSymbolWindow).toHaveBeenCalledWith(
        "BTC-EUR",
        "2026-10-31",
        "2026-11-01",
      );
      expect(series).toEqual([
        { from: "BTC", to: "EUR", date: "2026-11-01", rate: 136500 },
      ]);
    });

    it("keeps null (no answer) apart from [] (answered, nothing there)", async () => {
      yahoo.fetchPairSymbolWindow.mockResolvedValueOnce(null);
      expect(
        await provider.fetchDailySeries(
          "BTC",
          "CAD",
          "2026-11-01",
          "2026-11-02",
        ),
      ).toBeNull();

      yahoo.fetchPairSymbolWindow.mockResolvedValueOnce([]);
      expect(
        await provider.fetchDailySeries(
          "BTC",
          "CAD",
          "2026-11-01",
          "2026-11-02",
        ),
      ).toEqual([]);
    });

    it("answers nothing, asking nobody, for a pair it does not price", async () => {
      expect(
        await provider.fetchDailySeries(
          "CAD",
          "EUR",
          "2026-11-01",
          "2026-11-02",
        ),
      ).toEqual([]);
      expect(
        await provider.fetchDailySeries(
          "XYZ",
          "CAD",
          "2026-11-01",
          "2026-11-02",
        ),
      ).toEqual([]);
      expect(yahoo.fetchPairSymbolWindow).not.toHaveBeenCalled();
    });
  });

  /**
   * INV-CRYPTO-002 through the real chain: a fiat provider whose `carries` is
   * always true (Yahoo's) is never asked for a coin, and this adapter is never
   * asked for a fiat pair.
   */
  describe("in the chain", () => {
    it("takes the coin pair and leaves the fiat pair to the fiat provider", async () => {
      const fiat = {
        name: "yahoo" as const,
        source: "yahoo_finance",
        carries: jest.fn().mockResolvedValue(true),
        fetchLatest: jest.fn(
          async (base: string, quotes: readonly string[]) =>
            new Map(
              quotes.map((q) => [
                q,
                { from: base, to: q, date: "2026-11-05", rate: 0.68 },
              ]),
            ),
        ),
        fetchDailySeries: jest.fn().mockResolvedValue(null),
      };
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(93000));
      const chain = new FxProviderChain([fiat, provider]);

      const answer = await chain.latest("BTC", ["CAD", "EUR"]);
      const fiatAnswer = await chain.latest("CAD", ["EUR"]);

      expect(fiat.fetchLatest).toHaveBeenCalledTimes(1);
      expect(fiat.fetchLatest).toHaveBeenCalledWith("CAD", ["EUR"]);
      expect(answer.found.get("CAD")?.source).toBe("yahoo_crypto");
      expect(answer.found.get("EUR")?.source).toBe("yahoo_crypto");
      expect(fiatAnswer.found.get("EUR")?.source).toBe("yahoo_finance");
    });

    it("reports a coin without a price symbol as uncarried, asking nobody", async () => {
      const fiat = {
        name: "yahoo" as const,
        source: "yahoo_finance",
        carries: jest.fn().mockResolvedValue(true),
        fetchLatest: jest.fn().mockResolvedValue(new Map()),
        fetchDailySeries: jest.fn().mockResolvedValue(null),
      };
      const chain = new FxProviderChain([fiat, provider]);

      const answer = await chain.latest("CAD", ["XYZ"]);
      const series = await chain.dailySeries(
        "XYZ",
        "CAD",
        "2026-11-01",
        "2026-11-04",
      );

      expect(answer.uncarried).toEqual(["XYZ"]);
      expect(series).toEqual({
        points: [],
        answered: true,
        carried: false,
        source: null,
      });
      expect(fiat.fetchLatest).not.toHaveBeenCalled();
      expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolQuote).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolWindow).not.toHaveBeenCalled();
    });

    it("routes a coin created after the snapshot to the coin adapter, never to the fiat provider", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
      // The snapshot is read before BTC exists; BTC is then inserted as CRYPTO
      // (another replica's request, a restore) without this process hearing.
      const withoutBtc = CURRENCY_ROWS.filter((row) => row.code !== "BTC");
      currencyRepo.find
        .mockResolvedValueOnce(withoutBtc)
        .mockResolvedValue(CURRENCY_ROWS);
      const fiat = {
        name: "yahoo" as const,
        source: "yahoo_finance",
        carries: jest.fn().mockResolvedValue(true),
        fetchLatest: jest
          .fn()
          .mockResolvedValue(
            new Map([
              ["CAD", { from: "BTC", to: "CAD", date: "2026-11-05", rate: 1 }],
            ]),
          ),
        fetchDailySeries: jest.fn().mockResolvedValue(null),
      };
      const chain = new FxProviderChain([fiat, provider]);
      expect(await provider.claims("CAD")).toBe(false);
      jest.setSystemTime(Date.now() + CRYPTO_MISS_RELOAD_MS + 1);
      yahoo.fetchPairSymbolQuote.mockResolvedValue(quote(137000));

      const answer = await chain.latest("BTC", ["CAD"]);

      expect(fiat.fetchLatest).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledTimes(1);
      expect(yahoo.fetchPairSymbolQuote).toHaveBeenCalledWith("BTC-CAD");
      expect(answer.found.get("CAD")).toMatchObject({
        from: "BTC",
        to: "CAD",
        rate: 137000,
        source: "yahoo_crypto",
      });
    });

    it("asks nobody about a code the snapshot does not hold within the miss throttle, and reports the pair unanswered", async () => {
      jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
      // Read before BTC existed; BTC was then created on another replica.
      const withoutBtc = CURRENCY_ROWS.filter((row) => row.code !== "BTC");
      currencyRepo.find.mockResolvedValue(withoutBtc);
      const fiat = {
        name: "yahoo" as const,
        source: "yahoo_finance",
        carries: jest.fn().mockResolvedValue(true),
        fetchLatest: jest
          .fn()
          .mockResolvedValue(
            new Map([
              ["BTC", { from: "CAD", to: "BTC", date: "2026-11-05", rate: 1 }],
            ]),
          ),
        fetchDailySeries: jest
          .fn()
          .mockResolvedValue([
            { from: "CAD", to: "BTC", date: "2026-11-04", rate: 1 },
          ]),
      };
      const chain = new FxProviderChain([fiat, provider]);
      expect(await provider.claims("CAD")).toBe(false);

      // Still inside CRYPTO_MISS_RELOAD_MS: no re-read is allowed.
      const answer = await chain.latest("CAD", ["BTC"]);
      const series = await chain.dailySeries(
        "CAD",
        "BTC",
        "2026-11-01",
        "2026-11-04",
      );

      expect(currencyRepo.find).toHaveBeenCalledTimes(1);
      expect(answer).toEqual({
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
      expect(fiat.fetchLatest).not.toHaveBeenCalled();
      expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolQuote).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolWindow).not.toHaveBeenCalled();
    });

    it("hands no coin pair to the fiat provider when currencies cannot be read: the pairs are unanswered", async () => {
      currencyRepo.find.mockRejectedValue(new Error("connection reset"));
      const fiat = {
        name: "yahoo" as const,
        source: "yahoo_finance",
        carries: jest.fn().mockResolvedValue(true),
        fetchLatest: jest
          .fn()
          .mockResolvedValue(
            new Map([
              ["BTC", { from: "CAD", to: "BTC", date: "2026-11-05", rate: 1 }],
            ]),
          ),
        fetchDailySeries: jest.fn().mockResolvedValue([]),
      };
      const chain = new FxProviderChain([fiat, provider]);

      const answer = await chain.latest("CAD", ["BTC", "EUR"]);
      const series = await chain.dailySeries(
        "BTC",
        "CAD",
        "2026-11-01",
        "2026-11-04",
      );

      // Whether EUR is a coin cannot be told either, so it waits for the next
      // tick with BTC rather than being guessed at.
      expect(answer.found.size).toBe(0);
      expect(answer.unanswered).toEqual(["BTC", "EUR"]);
      expect(answer.uncarried).toEqual([]);
      expect(series).toEqual({
        points: [],
        answered: false,
        carried: true,
        source: null,
      });
      expect(fiat.fetchLatest).not.toHaveBeenCalled();
      expect(fiat.fetchDailySeries).not.toHaveBeenCalled();
      expect(yahoo.fetchPairSymbolQuote).not.toHaveBeenCalled();
    });
  });
});
