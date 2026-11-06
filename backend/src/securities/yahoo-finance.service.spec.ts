import { Logger } from "@nestjs/common";
import { YahooFinanceService, YahooQuoteResult } from "./yahoo-finance.service";
import { OPEN_WINDOW_MS } from "../provider-health/provider-circuit";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { createTestProviderHealth } from "../test-helpers/provider-health-testing";

describe("YahooFinanceService", () => {
  let service: YahooFinanceService;
  let health: ProviderHealthService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    health = createTestProviderHealth();
    service = new YahooFinanceService(health);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockFetchResponse = (data: any, ok = true, status = 200) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(data),
    });
  };

  const mockFetchError = (error: Error) => {
    global.fetch = jest.fn().mockRejectedValue(error);
  };

  /** Pre-seed the crumb cache so v10 tests skip the auth flow */
  const seedCrumb = () => {
    (service as any).crumb = "test-crumb";
    (service as any).cookie = "test-cookie";
    (service as any).crumbExpiresAt = Date.now() + 3600000;
  };

  /**
   * The crypto exchange rate provider may remember an absence, so it needs
   * "Yahoo says no such symbol" kept apart from "Yahoo did not answer"
   * (INV-FX-005); `fetchQuote` folds both into `null`.
   */
  describe("fetchQuoteAnswer", () => {
    it("answers the quote, asking the symbol as given", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "BTC-CAD",
                regularMarketPrice: 137250.12,
                regularMarketTime: 1762353000,
              },
            },
          ],
        },
      });

      const answer = await service.fetchQuoteAnswer("BTC-CAD");

      expect(answer?.quote?.regularMarketPrice).toBe(137250.12);
      expect(answer?.quote?.regularMarketTime).toBe(1762353000);
      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain("/v8/finance/chart/BTC-CAD?");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([404, 422])(
      "answers no quote when Yahoo reports the symbol absent with %i",
      async (status) => {
        mockFetchResponse({}, false, status);

        expect(await service.fetchQuoteAnswer("NOPE-CAD")).toEqual({
          quote: null,
        });
        // No alternate listing is tried for a coin pair.
        expect(global.fetch).toHaveBeenCalledTimes(1);
      },
    );

    it("answers no quote for a 200 whose chart error says Not Found", async () => {
      mockFetchResponse({
        chart: { result: null, error: { code: "Not Found" } },
      });

      expect(await service.fetchQuoteAnswer("NOPE-CAD")).toEqual({
        quote: null,
      });
    });

    it("is null for a fault, an unknown body or a network error: not an answer", async () => {
      mockFetchResponse({}, false, 500);
      expect(await service.fetchQuoteAnswer("BTC-CAD")).toBeNull();

      mockFetchResponse({
        chart: { result: null, error: { code: "Too Many Requests" } },
      });
      expect(await service.fetchQuoteAnswer("BTC-CAD")).toBeNull();

      mockFetchError(new Error("ECONNRESET"));
      expect(await service.fetchQuoteAnswer("BTC-CAD")).toBeNull();
    });

    it("leaves fetchQuote's answer for an absent symbol at null", async () => {
      mockFetchResponse({}, false, 404);

      expect(await service.fetchQuote("NOPE-CAD", "CRYPTO")).toBeNull();
    });
  });

  describe("fetchQuote", () => {
    it("should fetch and return quote data for a valid symbol", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                regularMarketPrice: 185.5,
                regularMarketDayHigh: 187.0,
                regularMarketDayLow: 183.0,
                regularMarketVolume: 55000000,
                regularMarketTime: 1700000000,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("AAPL");
      expect(result!.regularMarketPrice).toBe(185.5);
      expect(result!.regularMarketDayHigh).toBe(187.0);
      expect(result!.regularMarketDayLow).toBe(183.0);
      expect(result!.regularMarketVolume).toBe(55000000);
      expect(result!.regularMarketTime).toBe(1700000000);
    });

    it("falls back to indicators.quote[0].open when meta omits regularMarketOpen", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                regularMarketPrice: 185.5,
                regularMarketDayHigh: 187.0,
                regularMarketDayLow: 183.0,
                regularMarketVolume: 55000000,
                regularMarketTime: 1700000000,
              },
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [184.25],
                    high: [187.0],
                    low: [183.0],
                    close: [185.5],
                    volume: [55000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result).not.toBeNull();
      expect(result!.regularMarketOpen).toBe(184.25);
    });

    it("prefers meta.regularMarketOpen over indicators when both present", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                regularMarketPrice: 185.5,
                regularMarketOpen: 184.0,
              },
              indicators: {
                quote: [{ open: [999.99] }],
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result!.regularMarketOpen).toBe(184.0);
    });

    it("skips leading null entries in indicators.open when finding the day's open", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                regularMarketPrice: 185.5,
              },
              indicators: {
                quote: [{ open: [null, null, 184.25, 184.5] }],
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result!.regularMarketOpen).toBe(184.25);
    });

    it("converts indicators-sourced open from GBX to GBP for LSE stocks", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "VOD.L",
                currency: "GBp",
                regularMarketPrice: 7250,
              },
              indicators: {
                quote: [{ open: [7200] }],
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("VOD.L");

      expect(result!.regularMarketOpen).toBe(72);
    });

    it("should call fetch with correct URL and User-Agent header", async () => {
      mockFetchResponse({ chart: { result: [{ meta: { symbol: "AAPL" } }] } });

      await service.fetchQuote("AAPL");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "query1.finance.yahoo.com/v8/finance/chart/AAPL",
        ),
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.any(String),
          }),
        }),
      );
    });

    it("should URL-encode the symbol", async () => {
      mockFetchResponse({ chart: { result: [{ meta: { symbol: "BRK.B" } }] } });

      await service.fetchQuote("BRK.B");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("BRK.B"),
        expect.anything(),
      );
    });

    it("should return null when API returns non-OK response", async () => {
      mockFetchResponse({}, false, 404);

      const result = await service.fetchQuote("INVALID");

      expect(result).toBeNull();
    });

    it("should return null when chart result is missing", async () => {
      mockFetchResponse({ chart: { result: [] } });

      const result = await service.fetchQuote("AAPL");

      expect(result).toBeNull();
    });

    it("should return null when chart result has no meta", async () => {
      mockFetchResponse({ chart: { result: [{}] } });

      const result = await service.fetchQuote("AAPL");

      expect(result).toBeNull();
    });

    it("should return null when chart property is missing", async () => {
      mockFetchResponse({ error: "Not found" });

      const result = await service.fetchQuote("AAPL");

      expect(result).toBeNull();
    });

    it("should return null on network error", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.fetchQuote("AAPL");

      expect(result).toBeNull();
    });

    it("should convert GBX (pence) prices to GBP for LSE stocks", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "VOD.L",
                currency: "GBp",
                regularMarketPrice: 7250,
                regularMarketOpen: 7200,
                regularMarketDayHigh: 7300,
                regularMarketDayLow: 7100,
                regularMarketVolume: 10000000,
                regularMarketTime: 1700000000,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("VOD.L");

      expect(result).not.toBeNull();
      expect(result!.regularMarketPrice).toBe(72.5);
      expect(result!.regularMarketOpen).toBe(72);
      expect(result!.regularMarketDayHigh).toBe(73);
      expect(result!.regularMarketDayLow).toBe(71);
      expect(result!.regularMarketVolume).toBe(10000000);
    });

    it("keeps a null GBX field undefined instead of turning it into 0", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "VOD.L",
                currency: "GBp",
                regularMarketPrice: null,
                regularMarketDayHigh: 7300,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("VOD.L");

      expect(result!.regularMarketPrice).toBeUndefined();
      expect(result!.regularMarketDayHigh).toBe(73);
    });

    it("should not convert prices when currency is GBP (pounds)", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "IUKD.L",
                currency: "GBP",
                regularMarketPrice: 15.5,
                regularMarketVolume: 500000,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("IUKD.L");

      expect(result!.regularMarketPrice).toBe(15.5);
    });

    it("should not convert prices when currency is USD", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                currency: "USD",
                regularMarketPrice: 185.5,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result!.regularMarketPrice).toBe(185.5);
    });

    it("should not convert prices when currency field is absent", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                regularMarketPrice: 185.5,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AAPL");

      expect(result!.regularMarketPrice).toBe(185.5);
    });

    it("reports the instrument currency (USD passthrough)", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "AGGG.L",
                currency: "USD",
                regularMarketPrice: 4.37,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("AGGG.L", "LSE");

      expect(result!.currencyCode).toBe("USD");
    });

    it("normalizes a GBp (pence) currency to GBP", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                symbol: "VOD.L",
                currency: "GBp",
                regularMarketPrice: 7000,
              },
            },
          ],
        },
      });

      const result = await service.fetchQuote("VOD.L", "LSE");

      expect(result!.currencyCode).toBe("GBP");
    });
  });

  describe("fetchQuotes", () => {
    it("should return an empty map for empty symbols array", async () => {
      const results = await service.fetchQuotes([]);

      expect(results.size).toBe(0);
      // fetch should not have been called for an empty symbols array
    });

    it("should fetch quotes for multiple symbols", async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        const symbol = callCount === 1 ? "AAPL" : "MSFT";
        const price = callCount === 1 ? 185.5 : 370.0;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              chart: {
                result: [
                  {
                    meta: {
                      symbol,
                      regularMarketPrice: price,
                    },
                  },
                ],
              },
            }),
        });
      });

      const results = await service.fetchQuotes(["AAPL", "MSFT"]);

      expect(results.size).toBe(2);
      expect(results.get("AAPL")!.regularMarketPrice).toBe(185.5);
      expect(results.get("MSFT")!.regularMarketPrice).toBe(370.0);
    });

    it("should skip symbols that return null", async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    { meta: { symbol: "AAPL", regularMarketPrice: 185.5 } },
                  ],
                },
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const results = await service.fetchQuotes(["AAPL", "INVALID"]);

      expect(results.size).toBe(1);
      expect(results.has("AAPL")).toBe(true);
      expect(results.has("INVALID")).toBe(false);
    });
  });

  describe("fetchHistoricalSeries", () => {
    // The bars carry no currency, so the bundle has to: an acceptance point
    // cannot refuse a foreign listing it was never told about.
    it("carries the series currency, with the pence unit mapped to pounds once", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "GBp", symbol: "VOD.L" },
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [5000],
                    high: [5200],
                    low: [4900],
                    close: [5150],
                    volume: [1000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const series = await service.fetchHistoricalSeries("VOD.L");

      expect(series).not.toBeNull();
      expect(series!.currencyCode).toBe("GBP");
      expect(series!.symbol).toBe("VOD.L");
      // Pence divided into pounds exactly once, by the same read of the same
      // field that named the currency.
      expect(series!.prices[0].close).toBe(51.5);
    });

    it("reports no currency rather than guessing when the payload omits one", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [180],
                    high: [185],
                    low: [178],
                    close: [183],
                    volume: [50000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const series = await service.fetchHistoricalSeries("AAPL");

      expect(series!.currencyCode).toBeNull();
      expect(series!.prices).toHaveLength(1);
    });
  });

  describe("fetchHistoricalSeries", () => {
    // The bars carry no currency, so the bundle has to: an acceptance point
    // cannot refuse a foreign listing it was never told about.
    it("carries the series currency, with the pence unit mapped to pounds once", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "GBp", symbol: "VOD.L" },
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [5000],
                    high: [5200],
                    low: [4900],
                    close: [5150],
                    volume: [1000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const series = await service.fetchHistoricalSeries("VOD.L");

      expect(series).not.toBeNull();
      expect(series!.currencyCode).toBe("GBP");
      expect(series!.symbol).toBe("VOD.L");
      // Pence divided into pounds exactly once, by the same read of the same
      // field that named the currency.
      expect(series!.prices[0].close).toBe(51.5);
    });

    it("reports no currency rather than guessing when the payload omits one", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [180],
                    high: [185],
                    low: [178],
                    close: [183],
                    volume: [50000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const series = await service.fetchHistoricalSeries("AAPL");

      expect(series!.currencyCode).toBeNull();
      expect(series!.prices).toHaveLength(1);
    });
  });

  describe("fetchHistorical", () => {
    it("should fetch and parse historical price data", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000, 1700100000, 1700200000],
              indicators: {
                quote: [
                  {
                    open: [180, 182, 184],
                    high: [185, 187, 189],
                    low: [178, 180, 182],
                    close: [183, 186, 188],
                    volume: [50000000, 45000000, 55000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).not.toBeNull();
      expect(result!.length).toBe(3);
      expect(result![0].close).toBe(183);
      expect(result![0].open).toBe(180);
      expect(result![0].high).toBe(185);
      expect(result![0].low).toBe(178);
      expect(result![0].volume).toBe(50000000);
      expect(result![0].date).toBeInstanceOf(Date);
      // No adjclose series in this response → adjClose should be null
      expect(result![0].adjClose).toBeNull();
    });

    it("extracts adjusted close (split + dividend adjusted) when present", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000, 1700100000],
              indicators: {
                quote: [
                  {
                    open: [180, 182],
                    high: [185, 187],
                    low: [178, 180],
                    close: [183, 186],
                    volume: [50000000, 45000000],
                  },
                ],
                adjclose: [{ adjclose: [181, 184] }],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).not.toBeNull();
      expect(result![0].close).toBe(183);
      expect(result![0].adjClose).toBe(181);
      expect(result![1].close).toBe(186);
      expect(result![1].adjClose).toBe(184);
    });

    /**
     * A daily bar's timestamp is the instant its session opened, so the day it
     * belongs to is the exchange's calendar day. Deriving it with
     * `setHours(0,0,0,0)` read it on the *server's* calendar, which made
     * `security_prices.price_date` a function of the container's TZ -- and
     * silently wrong, not merely inconsistent, for any exchange whose open
     * falls on the other side of midnight UTC.
     */
    it("dates a bar by the exchange's calendar day, not the server's", async () => {
      // 2026-08-11T23:00:00Z is 10:00 on the 12th in Sydney: the bar belongs to
      // the 12th, and under a UTC server the old arithmetic filed it on the 11th.
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { exchangeTimezoneName: "Australia/Sydney" },
              timestamp: [Date.UTC(2026, 7, 11, 23, 0, 0) / 1000],
              indicators: { quote: [{ close: [100] }] },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("BHP", "ASX");

      expect(result![0].date.toISOString()).toBe("2026-08-12T00:00:00.000Z");
    });

    it("dates a bar in UTC when the provider names no exchange zone", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [Date.UTC(2026, 7, 11, 13, 30, 0) / 1000],
              indicators: { quote: [{ close: [100] }] },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result![0].date.toISOString()).toBe("2026-08-11T00:00:00.000Z");
    });

    it("should use range=max for historical data", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: { quote: [{ close: [100] }] },
            },
          ],
        },
      });

      await service.fetchHistorical("AAPL");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("range=max"),
        expect.anything(),
      );
    });

    it("should skip entries with null or NaN close prices", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000, 1700100000, 1700200000],
              indicators: {
                quote: [
                  {
                    open: [180, null, 184],
                    high: [185, null, 189],
                    low: [178, null, 182],
                    close: [183, null, 188],
                    volume: [50000000, null, 55000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      expect(result![0].close).toBe(183);
      expect(result![1].close).toBe(188);
    });

    it("should use null for missing OHLV values", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    close: [183],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).not.toBeNull();
      expect(result![0].open).toBeNull();
      expect(result![0].high).toBeNull();
      expect(result![0].low).toBeNull();
      expect(result![0].volume).toBeNull();
      expect(result![0].close).toBe(183);
    });

    it("should return null when API returns non-OK response", async () => {
      mockFetchResponse({}, false, 500);

      const result = await service.fetchHistorical("AAPL");

      expect(result).toBeNull();
    });

    it("returns an empty series when the window has no bars", async () => {
      // A result object with no timestamps is Yahoo answering "nothing traded
      // in that window" -- a year before the instrument existed, typically.
      // It is deliberately not `null`: null means no usable answer, and the
      // market-index chunking has to tell the two apart or it reads a refused
      // window as an empty year and stores a stub as the whole history.
      mockFetchResponse({
        chart: { result: [{ indicators: { quote: [{ close: [100] }] } }] },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).toEqual([]);
    });

    it("still returns null for a result it cannot parse", async () => {
      // Timestamps with no quote series is malformed, not empty: the caller's
      // alternate-symbol fallback should still get its turn.
      mockFetchResponse({
        chart: { result: [{ timestamp: [1700000000], indicators: {} }] },
      });

      expect(await service.fetchHistorical("AAPL")).toBeNull();
    });

    it("treats a delisted-symbol error as an answer, not a failure", async () => {
      // "No data found, symbol may be delisted" is the provider telling us
      // about the symbol. A caller may remember that; it may not remember a
      // 429 or a 5xx, which says nothing about the symbol at all.
      mockFetchResponse({
        chart: { result: null, error: { code: "Not Found" } },
      });

      expect(await service.fetchHistorical("NOPE")).toEqual([]);
    });

    it("returns null for a body it does not understand", async () => {
      mockFetchResponse({ unexpected: true });

      expect(await service.fetchHistorical("AAPL")).toBeNull();
    });

    it("reads a 404 as an answer and a 503 as none", async () => {
      mockFetchResponse({}, false, 404);
      expect(await service.fetchHistorical("NOPE")).toEqual([]);

      mockFetchResponse({}, false, 503);
      expect(await service.fetchHistorical("AAPL")).toBeNull();
    });

    it("reads a 400 that names an absent window as an answer, and any other 400 as none", async () => {
      // Issue #1409. Yahoo carries no USD/CAD history before December 2003 and
      // refuses the window with a 400 -- which IS an answer about the symbol
      // and the window, so the caller may remember it as empty. Read as a
      // refusal, the empty-window memory could never be written and a
      // since-inception valuation re-issued the same doomed calls on every
      // load. A 400 about the request itself stays a refusal.
      const respondWith = (body: unknown) => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      };

      respondWith({
        chart: {
          result: null,
          error: {
            code: "Bad Request",
            description:
              "Data doesn't exist for startDate = 1000684800, endDate = 1004486400",
          },
        },
      });
      expect(await service.fetchHistorical("USDCAD=X")).toEqual([]);

      respondWith({
        chart: {
          result: null,
          error: {
            code: "Bad Request",
            description: "Invalid input - interval=1z is not supported.",
          },
        },
      });
      expect(await service.fetchHistorical("AAPL")).toBeNull();

      // A body that is not JSON at all says nothing about the symbol either.
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("<html>Bad Request</html>"),
      });
      expect(await service.fetchHistorical("AAPL")).toBeNull();
    });

    it("should return null when indicators are missing", async () => {
      mockFetchResponse({
        chart: { result: [{ timestamp: [1700000000] }] },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).toBeNull();
    });

    it("should return null on network error", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.fetchHistorical("AAPL");

      expect(result).toBeNull();
    });

    it("should convert GBX historical prices to GBP", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "GBp" },
              timestamp: [1700000000, 1700100000],
              indicators: {
                quote: [
                  {
                    open: [5000, 5100],
                    high: [5200, 5300],
                    low: [4900, 5000],
                    close: [5150, 5250],
                    volume: [1000000, 900000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("VOD.L");

      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      expect(result![0].open).toBe(50);
      expect(result![0].high).toBe(52);
      expect(result![0].low).toBe(49);
      expect(result![0].close).toBe(51.5);
      expect(result![0].volume).toBe(1000000);
      expect(result![1].close).toBe(52.5);
    });

    it("should not convert historical prices when currency is USD", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "USD" },
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    open: [180],
                    high: [185],
                    low: [178],
                    close: [183],
                    volume: [50000000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result![0].close).toBe(183);
      expect(result![0].open).toBe(180);
    });

    it("should set hours to midnight on returned dates", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: {
                quote: [
                  {
                    close: [100],
                    open: [99],
                    high: [101],
                    low: [98],
                    volume: [1000],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result![0].date.getHours()).toBe(0);
      expect(result![0].date.getMinutes()).toBe(0);
      expect(result![0].date.getSeconds()).toBe(0);
    });
  });

  describe("searchQuotes", () => {
    it("asks the search endpoint for the count and answers the quotes", async () => {
      mockFetchResponse({
        quotes: [
          { symbol: "MYRUSD=X", quoteType: "CURRENCY", shortname: "MYR/USD" },
          { symbol: "MAYBANK.KL", quoteType: "EQUITY" },
        ],
      });

      const result = await service.searchQuotes("Ringgit Malaysia", 20);

      expect(result).toEqual([
        { symbol: "MYRUSD=X", quoteType: "CURRENCY", shortname: "MYR/USD" },
        { symbol: "MAYBANK.KL", quoteType: "EQUITY" },
      ]);
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe(
        "https://query1.finance.yahoo.com/v1/finance/search?q=Ringgit%20Malaysia&quotesCount=20&newsCount=0",
      );
    });

    it("drops an item without a symbol", async () => {
      mockFetchResponse({
        quotes: [{ quoteType: "CURRENCY" }, { symbol: "EURUSD=X" }],
      });

      expect(await service.searchQuotes("euro", 5)).toEqual([
        { symbol: "EURUSD=X" },
      ]);
    });

    it.each([
      ["no quotes", { quotes: [] }],
      ["no quotes property", {}],
    ])("is an empty answer for %s", async (_label, body) => {
      mockFetchResponse(body);

      expect(await service.searchQuotes("xyz", 20)).toEqual([]);
    });

    it("is no answer on a non-OK response", async () => {
      mockFetchResponse({}, false, 500);

      expect(await service.searchQuotes("xyz", 20)).toBeNull();
    });

    it("is no answer on a network error", async () => {
      mockFetchError(new Error("Network failure"));

      expect(await service.searchQuotes("xyz", 20)).toBeNull();
    });

    it("records the answer with the breaker once the body arrives", async () => {
      const recordSuccess = jest.spyOn(health, "recordSuccess");
      mockFetchResponse({ quotes: [] });

      await service.searchQuotes("xyz", 20);

      expect(recordSuccess).toHaveBeenCalledWith("yahoo_finance");
    });
  });

  describe("lookupSecurity", () => {
    it("should return the best matching security from search results", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "AAPL",
            longname: "Apple Inc.",
            shortname: "Apple",
            exchDisp: "NASDAQ",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("AAPL");

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("AAPL");
      expect(result!.name).toBe("Apple Inc.");
      expect(result!.securityType).toBe("STOCK");
      expect(result!.currencyCode).toBe("USD");
    });

    it("should prefer exact symbol match over first result", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "RY.TO",
            longname: "Royal Bank of Canada",
            exchDisp: "Toronto",
            typeDisp: "Equity",
          },
          {
            symbol: "RY",
            longname: "Royal Bank ADR",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("RY");

      expect(result).not.toBeNull();
      // RY.TO has TSX priority (1) vs RY which has US priority (2)
      // But exact match for "RY" is the second one - however TSX has higher priority
      // The sort puts TSX first, then looks for exact match among sorted
      expect(result!.symbol).toBe("RY");
    });

    it("should return null when no quotes are returned", async () => {
      mockFetchResponse({ quotes: [] });

      const result = await service.lookupSecurity("NONEXISTENT");

      expect(result).toBeNull();
    });

    it("should return null on non-OK response", async () => {
      mockFetchResponse({}, false, 500);

      const result = await service.lookupSecurity("AAPL");

      expect(result).toBeNull();
    });

    it("should return null on network error", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.lookupSecurity("AAPL");

      expect(result).toBeNull();
    });

    it("should map ETF type correctly", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "VTI",
            longname: "Vanguard Total Stock Market",
            typeDisp: "ETF",
          },
        ],
      });

      const result = await service.lookupSecurity("VTI");

      expect(result!.securityType).toBe("ETF");
    });

    it("should map Mutual Fund type correctly", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "VFIAX",
            longname: "Vanguard 500 Index",
            typeDisp: "Mutual Fund",
          },
        ],
      });

      const result = await service.lookupSecurity("VFIAX");

      expect(result!.securityType).toBe("MUTUAL_FUND");
    });

    it("should return null securityType for unknown types", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "TEST",
            longname: "Test Security",
            typeDisp: "Unknown",
          },
        ],
      });

      const result = await service.lookupSecurity("TEST");

      expect(result!.securityType).toBeNull();
    });

    it("should use shortname when longname is not available", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "TEST",
            shortname: "Test Corp",
          },
        ],
      });

      const result = await service.lookupSecurity("TEST");

      expect(result!.name).toBe("Test Corp");
    });

    it("should fall back to symbol when both longname and shortname are missing", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "TEST",
          },
        ],
      });

      const result = await service.lookupSecurity("TEST");

      expect(result!.name).toBe("TEST");
    });

    it("should detect LSE exchange and return GBP currency", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "VOD.L",
            longname: "Vodafone Group Plc",
            exchDisp: "LSE",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("VOD");

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("VOD");
      expect(result!.exchange).toBe("LSE");
      expect(result!.currencyCode).toBe("GBP");
    });

    it("should extract exchange from symbol suffix for TSX", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "RY.TO",
            longname: "Royal Bank of Canada",
          },
        ],
      });

      const result = await service.lookupSecurity("RY");

      expect(result!.exchange).toBe("TSX");
      expect(result!.currencyCode).toBe("CAD");
    });

    it("should prioritize Canadian exchanges in sorting", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "ENB",
            longname: "Enbridge Inc US",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
          {
            symbol: "ENB.TO",
            longname: "Enbridge Inc",
            exchDisp: "Toronto",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("ENB");

      // ENB.TO should be prioritized (TSX priority = 1)
      expect(result!.symbol).toBe("ENB");
      expect(result!.exchange).toBe("TSX");
    });

    it("should handle empty quotes array in response", async () => {
      mockFetchResponse({ quotes: [] });

      const result = await service.lookupSecurity("NOTHING");

      expect(result).toBeNull();
    });

    it("should prefer LSE when specified as preferred exchange", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "VOD",
            longname: "Vodafone Group (US ADR)",
            exchDisp: "NASDAQ",
            typeDisp: "Equity",
          },
          {
            symbol: "VOD.L",
            longname: "Vodafone Group Plc",
            exchDisp: "LSE",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("VOD", ["LSE"]);

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("VOD");
      expect(result!.exchange).toBe("LSE");
      expect(result!.currencyCode).toBe("GBP");
    });

    it("should prefer ASX when specified as preferred exchange", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "CBA",
            longname: "CBA US Listed",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
          {
            symbol: "CBA.AX",
            longname: "Commonwealth Bank of Australia",
            exchDisp: "ASX",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("CBA", ["ASX"]);

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("CBA");
      expect(result!.exchange).toBe("ASX");
      expect(result!.currencyCode).toBe("AUD");
    });

    it("should respect priority ordering of multiple preferred exchanges", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "TEST",
            longname: "Test Corp US",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
          {
            symbol: "TEST.AX",
            longname: "Test Corp AU",
            exchDisp: "ASX",
            typeDisp: "Equity",
          },
          {
            symbol: "TEST.L",
            longname: "Test Corp UK",
            exchDisp: "LSE",
            typeDisp: "Equity",
          },
        ],
      });

      // LSE is first preferred, should win even though ASX is also preferred
      const result = await service.lookupSecurity("TEST", ["LSE", "ASX"]);

      expect(result).not.toBeNull();
      expect(result!.exchange).toBe("LSE");
    });

    it("should fall back to default priority when no preferred exchange matches", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "ENB",
            longname: "Enbridge Inc US",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
          {
            symbol: "ENB.TO",
            longname: "Enbridge Inc",
            exchDisp: "Toronto",
            typeDisp: "Equity",
          },
        ],
      });

      // Frankfurt preferred but not in results; falls back to default CA > US
      const result = await service.lookupSecurity("ENB", ["Frankfurt"]);

      expect(result!.symbol).toBe("ENB");
      expect(result!.exchange).toBe("TSX");
    });

    it("should work with empty preferred exchanges array", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "AAPL",
            longname: "Apple Inc.",
            exchDisp: "NASDAQ",
            typeDisp: "Equity",
          },
        ],
      });

      const result = await service.lookupSecurity("AAPL", []);

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("AAPL");
    });
  });

  /**
   * Discussion #2005 / issue #379: a coin was looked up as USD on Yahoo's `CCC`
   * venue whatever its quote fiat, because the exchange guess reads every
   * dotless symbol as USD. Saved that way, every EUR price for `BTC-EUR` is
   * refused by `verifyProviderCurrency` and the holding never gets a value.
   */
  describe("lookupSecurityMany for a cryptocurrency", () => {
    const coin = (symbol: string, extra: Record<string, string> = {}) => ({
      symbol,
      shortname: `${symbol} coin`,
      quoteType: "CRYPTOCURRENCY",
      exchange: "CCC",
      exchDisp: "CCC",
      typeDisp: "Cryptocurrency",
      ...extra,
    });

    it("takes the currency from the fiat leg and names the canonical exchange", async () => {
      mockFetchResponse({ quotes: [coin("BTC-EUR")] });

      const [result] = await service.lookupSecurityMany("BTC-EUR");

      expect(result).toMatchObject({
        symbol: "BTC-EUR",
        exchange: "CRYPTO",
        securityType: "CRYPTO",
        currencyCode: "EUR",
      });
    });

    it("reads a USD pair as USD and a CAD pair as CAD", async () => {
      mockFetchResponse({ quotes: [coin("BTC-USD"), coin("DOT-CAD")] });

      const results = await service.lookupSecurityMany("BTC");

      expect(
        results.map((r) => [r.symbol, r.exchange, r.currencyCode]),
      ).toEqual([
        ["BTC-USD", "CRYPTO", "USD"],
        ["DOT-CAD", "CRYPTO", "CAD"],
      ]);
    });

    it("recognises a coin by quoteType alone", async () => {
      mockFetchResponse({
        quotes: [{ symbol: "ETH-GBP", quoteType: "CRYPTOCURRENCY" }],
      });

      const [result] = await service.lookupSecurityMany("ETH-GBP");

      expect(result).toMatchObject({
        exchange: "CRYPTO",
        securityType: "CRYPTO",
        currencyCode: "GBP",
      });
    });

    // Unknown is null, never USD: the form then asks the person for the
    // currency instead of saving one every price will be refused against.
    it("reports no currency for a coin symbol without a fiat leg", async () => {
      mockFetchResponse({ quotes: [coin("BTC"), coin("BTC-USDT")] });

      const results = await service.lookupSecurityMany("BTC");

      expect(results.map((r) => [r.symbol, r.currencyCode])).toEqual([
        ["BTC", null],
        ["BTC-USDT", null],
      ]);
      expect(results.every((r) => r.exchange === "CRYPTO")).toBe(true);
    });

    it("still reads a dotless US equity as USD", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "BRK-B",
            quoteType: "EQUITY",
            exchDisp: "NYSE",
            typeDisp: "Equity",
          },
        ],
      });

      const [result] = await service.lookupSecurityMany("BRK-B");

      expect(result).toMatchObject({
        symbol: "BRK-B",
        exchange: "NYSE",
        securityType: "STOCK",
        currencyCode: "USD",
      });
    });

    it("applies the same rule to the single-result lookup", async () => {
      mockFetchResponse({ quotes: [coin("BTC-EUR")] });

      const result = await service.lookupSecurity("BTC-EUR");

      expect(result).toMatchObject({
        exchange: "CRYPTO",
        currencyCode: "EUR",
      });
    });
  });

  describe("getYahooSymbol", () => {
    it("should return symbol with .TO suffix for TSX exchange", () => {
      expect(service.getYahooSymbol("RY", "TSX")).toBe("RY.TO");
    });

    it("should return symbol with .TO suffix for TSE exchange", () => {
      expect(service.getYahooSymbol("RY", "TSE")).toBe("RY.TO");
    });

    it("should return symbol with .TO suffix for Toronto exchange", () => {
      expect(service.getYahooSymbol("RY", "Toronto")).toBe("RY.TO");
    });

    it("should return symbol with .V suffix for TSX-V exchange", () => {
      expect(service.getYahooSymbol("ABC", "TSX-V")).toBe("ABC.V");
    });

    it("should return symbol with .CN suffix for CSE exchange", () => {
      expect(service.getYahooSymbol("WEED", "CSE")).toBe("WEED.CN");
    });

    it("should return symbol with no suffix for NYSE", () => {
      expect(service.getYahooSymbol("AAPL", "NYSE")).toBe("AAPL");
    });

    it("should return symbol with no suffix for NASDAQ", () => {
      expect(service.getYahooSymbol("MSFT", "NASDAQ")).toBe("MSFT");
    });

    it("should return symbol unchanged if it already contains a dot", () => {
      expect(service.getYahooSymbol("RY.TO", "NYSE")).toBe("RY.TO");
    });

    it("should return symbol unchanged for null exchange", () => {
      expect(service.getYahooSymbol("AAPL", null)).toBe("AAPL");
    });

    it("should return symbol unchanged for unknown exchange", () => {
      expect(service.getYahooSymbol("TEST", "UNKNOWN_EXCHANGE")).toBe("TEST");
    });

    // A coin is quoted under its full Yahoo symbol; an exchange suffix would
    // name a listing that does not exist.
    it("returns a crypto pair unchanged on the CRYPTO exchange", () => {
      expect(service.getYahooSymbol("BTC-EUR", "CRYPTO")).toBe("BTC-EUR");
      expect(service.getYahooSymbol("BTC-EUR", "CCC")).toBe("BTC-EUR");
    });

    it("should handle case-insensitive exchange matching", () => {
      expect(service.getYahooSymbol("RY", "tsx")).toBe("RY.TO");
      expect(service.getYahooSymbol("AAPL", "nyse")).toBe("AAPL");
    });

    it("should return symbol with .L suffix for LSE exchange", () => {
      expect(service.getYahooSymbol("VOD", "LSE")).toBe("VOD.L");
    });

    it("should return symbol with .AX suffix for ASX exchange", () => {
      expect(service.getYahooSymbol("CBA", "ASX")).toBe("CBA.AX");
    });

    it("should return symbol with .F suffix for Frankfurt exchange", () => {
      expect(service.getYahooSymbol("SAP", "Frankfurt")).toBe("SAP.F");
    });

    it("should return symbol with .DE suffix for XETRA exchange", () => {
      expect(service.getYahooSymbol("SAP", "XETRA")).toBe("SAP.DE");
    });

    it("should return symbol with .HK suffix for HKEX exchange", () => {
      expect(service.getYahooSymbol("0005", "HKEX")).toBe("0005.HK");
    });

    it("should return symbol with .T suffix for Tokyo exchange", () => {
      expect(service.getYahooSymbol("7203", "Tokyo")).toBe("7203.T");
    });

    it("should return symbol with .PA suffix for Paris exchange", () => {
      expect(service.getYahooSymbol("LVMH", "Paris")).toBe("LVMH.PA");
    });

    it("should handle Toronto Stock Exchange full name", () => {
      expect(service.getYahooSymbol("RY", "Toronto Stock Exchange")).toBe(
        "RY.TO",
      );
    });
  });

  describe("getAlternateSymbols", () => {
    it("should return Canadian exchange alternates for plain symbols", () => {
      const alternates = service.getAlternateSymbols("RY");

      expect(alternates).toContain("RY.TO");
      expect(alternates).toContain("RY.V");
      expect(alternates).toContain("RY.CN");
    });

    it("should return empty array for symbols that already have a dot", () => {
      const alternates = service.getAlternateSymbols("RY.TO");

      expect(alternates).toEqual([]);
    });

    it("should return exactly 3 alternates for plain symbols", () => {
      const alternates = service.getAlternateSymbols("AAPL");

      expect(alternates.length).toBe(3);
    });

    // A currency pair is not listed on an exchange, so `USDCAD=X.TO` is three
    // guaranteed misses -- and the on-demand historical FX fill asks for a pair
    // precisely when nothing is stored for it, so the miss path is its own.
    it("returns no alternates for a currency pair", () => {
      expect(service.getAlternateSymbols("USDCAD=X")).toEqual([]);
      expect(service.getAlternateSymbols("CADUSD=X")).toEqual([]);
    });

    // A coin trades on no exchange either, so `BTC-EUR.TO` is three more
    // guaranteed misses on every refresh Yahoo did not answer. The exchange
    // says so, whatever the symbol's last leg: `USDT` is no ISO code.
    it("returns no alternates for a security on the crypto exchange", () => {
      expect(service.getAlternateSymbols("BTC-EUR", "CRYPTO")).toEqual([]);
      expect(service.getAlternateSymbols("BTC-USDT", "CRYPTO")).toEqual([]);
      expect(service.getAlternateSymbols("BTC", "CRYPTO")).toEqual([]);
    });

    // A coin created before the lookup named `CRYPTO` still carries `CCC`.
    it("returns no alternates for a coin still on Yahoo's CCC venue", () => {
      expect(service.getAlternateSymbols("DOT-CAD", "CCC")).toEqual([]);
    });

    // The symbol's shape decides nothing: a hyphenated listing keeps its
    // Canadian suffixes, as does a dotless symbol with no exchange.
    it("keeps the alternates of a hyphenated listing", () => {
      expect(service.getAlternateSymbols("ENB-PFU", "TSX")).toEqual([
        "ENB-PFU.TO",
        "ENB-PFU.V",
        "ENB-PFU.CN",
      ]);
      expect(service.getAlternateSymbols("RY", null)).toEqual([
        "RY.TO",
        "RY.V",
        "RY.CN",
      ]);
    });

    // Each fetch path hands the security's exchange through, so a coin that
    // misses costs one request, not four.
    it("tries no alternates when a crypto quote misses", async () => {
      mockFetchResponse({ chart: { result: [] } });

      await service.fetchQuote("BTC-USDT", "CRYPTO");

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getTradingDate", () => {
    it("should return date from regularMarketTime when present", () => {
      const quote: YahooQuoteResult = {
        symbol: "AAPL",
        regularMarketTime: 1700000000,
      };

      const result = service.getTradingDate(quote);

      expect(result).toBeInstanceOf(Date);
      expect(result.getUTCHours()).toBe(0);
      expect(result.getUTCMinutes()).toBe(0);
      expect(result.getUTCSeconds()).toBe(0);
    });

    it("should return today for weekday when regularMarketTime is missing", () => {
      const quote: YahooQuoteResult = {
        symbol: "AAPL",
      };

      const result = service.getTradingDate(quote);

      expect(result).toBeInstanceOf(Date);
      expect(result.getUTCHours()).toBe(0);

      // The date should be adjusted if it falls on weekend
      const day = result.getDay();
      expect(day).not.toBe(0); // Not Sunday
      expect(day).not.toBe(6); // Not Saturday
    });

    it("should adjust Sunday to Friday", () => {
      const quote: YahooQuoteResult = { symbol: "AAPL" };

      // We test the logic: if today is Sunday, subtract 2 days
      // This is tested indirectly - the day returned should never be 0 or 6
      const result = service.getTradingDate(quote);
      const day = result.getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    });
  });

  describe("extractBaseSymbol", () => {
    it("should remove exchange suffix from symbol", () => {
      expect(service.extractBaseSymbol("RY.TO")).toBe("RY");
    });

    it("should return symbol unchanged if no dot present", () => {
      expect(service.extractBaseSymbol("AAPL")).toBe("AAPL");
    });

    it("should handle multiple dots (take last dot)", () => {
      expect(service.extractBaseSymbol("BRK.B")).toBe("BRK");
    });

    it("should handle dot at position 0 (return original)", () => {
      // A symbol starting with dot is unusual; dot at index 0 means dotIndex is 0 which is not > 0
      expect(service.extractBaseSymbol(".TO")).toBe(".TO");
    });
  });

  describe("extractExchangeFromSymbol", () => {
    it("should extract TSX from .TO suffix", () => {
      expect(service.extractExchangeFromSymbol("RY.TO")).toBe("TSX");
    });

    it("should extract TSX-V from .V suffix", () => {
      expect(service.extractExchangeFromSymbol("ABC.V")).toBe("TSX-V");
    });

    it("should extract CSE from .CN suffix", () => {
      expect(service.extractExchangeFromSymbol("WEED.CN")).toBe("CSE");
    });

    it("should extract LSE from .L suffix", () => {
      expect(service.extractExchangeFromSymbol("VOD.L")).toBe("LSE");
    });

    it("should extract ASX from .AX suffix", () => {
      expect(service.extractExchangeFromSymbol("CBA.AX")).toBe("ASX");
    });

    it("should return null for symbols without dot", () => {
      expect(service.extractExchangeFromSymbol("AAPL")).toBeNull();
    });

    it("should return null for unknown suffixes", () => {
      expect(service.extractExchangeFromSymbol("TEST.XX")).toBeNull();
    });

    it("should return null for dot at position 0", () => {
      expect(service.extractExchangeFromSymbol(".TO")).toBeNull();
    });
  });

  describe("getExchangePriority", () => {
    it("should return priority 1 for TSX symbols (.TO)", () => {
      expect(service.getExchangePriority("RY.TO")).toBe(1);
    });

    it("should return priority 1 for TSX-V symbols (.V)", () => {
      expect(service.getExchangePriority("ABC.V")).toBe(1);
    });

    it("should return priority 1 for CSE symbols (.CN)", () => {
      expect(service.getExchangePriority("WEED.CN")).toBe(1);
    });

    it("should return priority 1 for NEO symbols (.NE)", () => {
      expect(service.getExchangePriority("TEST.NE")).toBe(1);
    });

    it("should return priority 1 for Toronto exchange display", () => {
      expect(service.getExchangePriority("RY", "Toronto")).toBe(1);
    });

    it("should return priority 1 for TSX exchange display", () => {
      expect(service.getExchangePriority("RY", "TSX")).toBe(1);
    });

    it("should return priority 2 for US symbols without suffix", () => {
      expect(service.getExchangePriority("AAPL")).toBe(2);
    });

    it("should return priority 2 for NYSE exchange display", () => {
      expect(service.getExchangePriority("AAPL", "NYSE")).toBe(2);
    });

    it("should return priority 2 for NASDAQ exchange display", () => {
      expect(service.getExchangePriority("MSFT", "NASDAQ")).toBe(2);
    });

    it("should return priority 2 for NMS exchange code", () => {
      expect(service.getExchangePriority("MSFT", "NMS")).toBe(2);
    });

    it("should return priority 3 for other international exchanges", () => {
      expect(service.getExchangePriority("VOD.L")).toBe(3);
    });

    it("should return priority 3 for unknown exchanges", () => {
      expect(service.getExchangePriority("TEST.XX", "Unknown")).toBe(3);
    });

    describe("with preferredExchanges", () => {
      it("should give highest priority to first preferred exchange", () => {
        // LSE preferred, LSE result should get priority < 1 (the default CA priority)
        expect(
          service.getExchangePriority("VOD.L", "LSE", ["LSE"]),
        ).toBeLessThan(0);
      });

      it("should rank first preferred higher than second preferred", () => {
        const first = service.getExchangePriority("VOD.L", "LSE", [
          "LSE",
          "ASX",
        ]);
        const second = service.getExchangePriority("CBA.AX", "ASX", [
          "LSE",
          "ASX",
        ]);
        expect(first).toBeLessThan(second);
      });

      it("should rank all preferred exchanges above default tiers", () => {
        const preferred = service.getExchangePriority("VOD.L", "LSE", ["LSE"]);
        const defaultCA = service.getExchangePriority("RY.TO", "Toronto");
        expect(preferred).toBeLessThan(defaultCA);
      });

      it("should fall back to default priority for non-preferred exchanges", () => {
        // ASX not in preferred list, should get default priority 3
        expect(service.getExchangePriority("CBA.AX", "ASX", ["LSE"])).toBe(3);
      });

      it("should match preferred exchange by suffix", () => {
        expect(
          service.getExchangePriority("CBA.AX", undefined, ["ASX"]),
        ).toBeLessThan(0);
      });

      it("should match preferred exchange by exchDisp", () => {
        expect(
          service.getExchangePriority("VOD", "London", ["LSE"]),
        ).toBeLessThan(0);
      });

      it("should handle three preferred exchanges with correct ordering", () => {
        const first = service.getExchangePriority("VOD.L", "LSE", [
          "LSE",
          "ASX",
          "TSX",
        ]);
        const second = service.getExchangePriority("CBA.AX", "ASX", [
          "LSE",
          "ASX",
          "TSX",
        ]);
        const third = service.getExchangePriority("RY.TO", "Toronto", [
          "LSE",
          "ASX",
          "TSX",
        ]);
        expect(first).toBeLessThan(second);
        expect(second).toBeLessThan(third);
        expect(third).toBeLessThan(0);
      });

      it("should handle empty preferred exchanges array like no preference", () => {
        expect(service.getExchangePriority("RY.TO", "Toronto", [])).toBe(1);
        expect(service.getExchangePriority("AAPL", "NYSE", [])).toBe(2);
      });

      it("should fallback to exchDisp matching for unknown preferred exchange names", () => {
        // "BOMBAY" is not in the matcher map, but exchDisp includes it
        expect(
          service.getExchangePriority("RELIANCE", "BOMBAY", ["BOMBAY"]),
        ).toBeLessThan(0);
      });
    });
  });

  describe("fetchStockSectorInfo", () => {
    it("returns sector and industry from search API response", async () => {
      mockFetchResponse({
        quotes: [
          {
            symbol: "AAPL",
            sector: "Technology",
            industry: "Consumer Electronics",
          },
        ],
      });

      const result = await service.fetchStockSectorInfo("AAPL");

      expect(result).toEqual({
        sector: "Technology",
        industry: "Consumer Electronics",
      });
    });

    it("returns null when API returns non-200", async () => {
      mockFetchResponse({}, false, 404);

      const result = await service.fetchStockSectorInfo("INVALID");

      expect(result).toBeNull();
    });

    it("returns null when fetch throws (network error)", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.fetchStockSectorInfo("AAPL");

      expect(result).toBeNull();
    });

    it("returns null sector/industry when no matching symbol found", async () => {
      mockFetchResponse({ quotes: [{ symbol: "OTHER" }] });

      const result = await service.fetchStockSectorInfo("AAPL");

      expect(result).toEqual({ sector: null, industry: null });
    });

    it("uses sectorDisp fallback when sector is missing", async () => {
      mockFetchResponse({
        quotes: [
          { symbol: "AAPL", sectorDisp: "Tech", industryDisp: "Electronics" },
        ],
      });

      const result = await service.fetchStockSectorInfo("AAPL");

      expect(result).toEqual({ sector: "Tech", industry: "Electronics" });
    });

    it("constructs correct search URL with encoded symbol", async () => {
      mockFetchResponse({ quotes: [] });

      await service.fetchStockSectorInfo("BRK.B");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("v1/finance/search?q=BRK.B"),
        expect.anything(),
      );
    });
  });

  describe("fetchEtfAssetPositions", () => {
    beforeEach(() => seedCrumb());

    it("returns the fund's asset-class split as weights", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                stockPosition: { raw: 0.006 },
                bondPosition: { raw: 0.98 },
                cashPosition: { raw: 0.014 },
              },
            },
          ],
        },
      });

      const result = await service.fetchEtfAssetPositions("AGGG", "LSE");

      expect(result).toEqual([
        { name: "Stocks", weight: 0.006 },
        { name: "Bonds", weight: 0.98 },
        { name: "Cash", weight: 0.014 },
      ]);
    });

    it("drops the unattributed remainder rather than storing it", async () => {
      // A shortfall under 100% is shown as "Other" at display time; storing
      // Yahoo's own otherPosition too would double-count it.
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                stockPosition: { raw: 0.9 },
                otherPosition: { raw: 0.1 },
              },
            },
          ],
        },
      });

      const result = await service.fetchEtfAssetPositions("VTI");

      expect(result).toEqual([{ name: "Stocks", weight: 0.9 }]);
    });

    it("skips positions the provider reports as zero or missing", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                stockPosition: { raw: 1 },
                bondPosition: { raw: 0 },
                cashPosition: {},
              },
            },
          ],
        },
      });

      expect(await service.fetchEtfAssetPositions("VTI")).toEqual([
        { name: "Stocks", weight: 1 },
      ]);
    });

    it("is empty when the provider knows the fund but holds no split", async () => {
      mockFetchResponse({ quoteSummary: { result: [{}] } });
      expect(await service.fetchEtfAssetPositions("VTI")).toEqual([]);
    });
  });

  describe("fetchEtfBreakdowns", () => {
    beforeEach(() => seedCrumb());

    it("returns both breakdowns from a single request", async () => {
      // Sectors and asset positions arrive in the same topHoldings module, so
      // fetching them separately was two identical round trips per fund.
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                stockPosition: { raw: 1 },
                sectorWeightings: [{ technology: { raw: 0.3 } }],
              },
            },
          ],
        },
      });
      const callsBefore = (global.fetch as jest.Mock).mock.calls.length;

      const result = await service.fetchEtfBreakdowns("VTI");

      expect(result).toEqual({
        sectors: [{ sector: "Technology", weight: 0.3 }],
        assets: [{ name: "Stocks", weight: 1 }],
      });
      expect((global.fetch as jest.Mock).mock.calls.length - callsBefore).toBe(
        1,
      );
    });

    it("reports both halves as unknown when the request fails", async () => {
      // Null is "we could not ask", which a caller must not store as "none".
      mockFetchResponse({}, false, 500);
      expect(await service.fetchEtfBreakdowns("VTI")).toEqual({
        sectors: null,
        assets: null,
      });
    });
  });

  describe("fetchEtfSectorWeightings", () => {
    beforeEach(() => seedCrumb());

    it("returns normalized sector array from valid topHoldings response", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                sectorWeightings: [
                  { technology: { raw: 0.3 } },
                  { healthcare: { raw: 0.15 } },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result).toEqual([
        { sector: "Technology", weight: 0.3 },
        { sector: "Healthcare", weight: 0.15 },
      ]);
    });

    it("normalizes Yahoo keys to display names", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                sectorWeightings: [
                  { realestate: { raw: 0.05 } },
                  { consumer_cyclical: { raw: 0.1 } },
                  { financial_services: { raw: 0.12 } },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result!.map((r) => r.sector)).toEqual([
        "Real Estate",
        "Consumer Cyclical",
        "Financial Services",
      ]);
    });

    it("filters out entries with weight = 0", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              topHoldings: {
                sectorWeightings: [
                  { technology: { raw: 0.3 } },
                  { healthcare: { raw: 0 } },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result).toHaveLength(1);
      expect(result![0].sector).toBe("Technology");
    });

    it("returns null when API returns non-200", async () => {
      mockFetchResponse({}, false, 500);

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result).toBeNull();
    });

    it("returns empty array when topHoldings has no sectorWeightings", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [{ topHoldings: {} }],
        },
      });

      const result = await service.fetchEtfSectorWeightings("VTI");

      expect(result).toEqual([]);
    });
  });

  describe("fetchIntradaySeries", () => {
    it("parses timestamps and closes for the requested interval", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "USD" },
              timestamp: [1714989000, 1714989060, 1714989120],
              indicators: {
                quote: [
                  {
                    open: [99.5, 100.8, 101.4],
                    close: [100, 101, 102],
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.fetchIntradaySeries("AAPL", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result).toHaveLength(3);
      expect(result![0].close).toBe(100);
      expect(result![0].open).toBe(99.5);
      expect(result![2].timestamp.getTime()).toBe(1714989120 * 1000);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("interval=1m&range=1d"),
        expect.any(Object),
      );
    });

    it("returns null open when the provider omits the open array", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "USD" },
              timestamp: [1, 2],
              indicators: { quote: [{ close: [100, 101] }] },
            },
          ],
        },
      });

      const result = await service.fetchIntradaySeries("AAPL", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result![0].open).toBeNull();
      expect(result![0].close).toBe(100);
    });

    it("converts GBX opens to GBP alongside closes", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "GBX" },
              timestamp: [1],
              indicators: { quote: [{ open: [199], close: [200] }] },
            },
          ],
        },
      });

      const result = await service.fetchIntradaySeries("BARC.L", "LSE", {
        interval: "1m",
        range: "1d",
      });

      expect(result![0].open).toBe(1.99);
      expect(result![0].close).toBe(2);
    });

    it("forward-fills null closes so multi-security alignment works", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "USD" },
              timestamp: [1, 2, 3, 4],
              indicators: { quote: [{ close: [100, null, null, 105] }] },
            },
          ],
        },
      });

      const result = await service.fetchIntradaySeries("AAPL", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result!.map((p) => p.close)).toEqual([100, 100, 100, 105]);
    });

    it("converts GBX prices to GBP", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: { currency: "GBX" },
              timestamp: [1],
              indicators: { quote: [{ close: [200] }] },
            },
          ],
        },
      });

      const result = await service.fetchIntradaySeries("BARC.L", "LSE", {
        interval: "1m",
        range: "1d",
      });

      expect(result![0].close).toBe(2);
    });

    it("returns null when the API responds with an error status", async () => {
      mockFetchResponse({}, false, 500);

      const result = await service.fetchIntradaySeries("AAPL", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result).toBeNull();
    });
  });

  describe("rate-limit handling (throttledFetch)", () => {
    // Make backoff effectively zero so the retry path runs synchronously
    // for tests; the real values are unit-tested elsewhere.
    beforeEach(() => {
      (YahooFinanceService as any).RETRY_INITIAL_DELAY_MS = 0;
      (YahooFinanceService as any).INTER_REQUEST_GAP_MS = 0;
    });

    const okIntradayResponse = () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                meta: { currency: "USD" },
                timestamp: [1],
                indicators: { quote: [{ close: [100] }] },
              },
            ],
          },
        }),
    });

    const throttledResponse = (status: number) => ({
      ok: false,
      status,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });

    it("retries on a 429 response and succeeds on the next attempt", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(throttledResponse(429))
        .mockResolvedValueOnce(okIntradayResponse());
      global.fetch = fetchMock as any;

      const result = await service.fetchIntradaySeries("AAPL.TO", null, {
        interval: "1m",
        range: "1d",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
      expect(result![0].close).toBe(100);
    });

    it("retries on a 503 response and succeeds on the next attempt", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(throttledResponse(503))
        .mockResolvedValueOnce(okIntradayResponse());
      global.fetch = fetchMock as any;

      const result = await service.fetchIntradaySeries("AAPL.TO", null, {
        interval: "1m",
        range: "1d",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
    });

    it("gives up after the configured retry budget and returns null", async () => {
      // Intraday allows maxRetries=1 (so 2 total attempts) per service config.
      const fetchMock = jest.fn().mockResolvedValue(throttledResponse(429));
      global.fetch = fetchMock as any;

      const result = await service.fetchIntradaySeries("AAPL.TO", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry non-throttled errors (e.g. 500)", async () => {
      const fetchMock = jest.fn().mockResolvedValue(throttledResponse(500));
      global.fetch = fetchMock as any;

      const result = await service.fetchIntradaySeries("AAPL.TO", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caps concurrent in-flight requests", async () => {
      // Drive 10 parallel intraday requests through a fetch that hangs until
      // we count how many have started simultaneously.
      let inFlight = 0;
      let peak = 0;
      const fetchMock = jest.fn().mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return okIntradayResponse();
      });
      global.fetch = fetchMock as any;

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.fetchIntradaySeries(`SYM${i}.TO`, null, {
            interval: "1m",
            range: "1d",
          }),
        ),
      );

      expect(peak).toBeLessThanOrEqual(
        (YahooFinanceService as any).MAX_CONCURRENT_REQUESTS,
      );
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("honors the Retry-After header when the server provides one", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "0" }),
          text: () => Promise.resolve(""),
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce(okIntradayResponse());
      global.fetch = fetchMock as any;

      const result = await service.fetchIntradaySeries("AAPL.TO", null, {
        interval: "1m",
        range: "1d",
      });

      expect(result).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchSecurityProfileDescription", () => {
    beforeEach(() => seedCrumb());

    it("returns stock prose verbatim from summaryProfile", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              summaryProfile: {
                longBusinessSummary:
                  "Apple Inc. designs, manufactures and markets smartphones.",
              },
            },
          ],
        },
      });

      const result = await service.fetchSecurityProfileDescription("AAPL");

      expect(result).toBe(
        "Apple Inc. designs, manufactures and markets smartphones.",
      );
    });

    it("synthesizes a fund one-liner from structured modules", async () => {
      mockFetchResponse({
        quoteSummary: {
          result: [
            {
              quoteType: {
                longName: "iShares Core Global Aggregate Bond UCITS ETF",
              },
              fundProfile: {
                family: "BlackRock",
                feesExpensesInvestment: {
                  annualReportExpenseRatio: { raw: 0.001 },
                },
              },
              topHoldings: {
                bondPosition: { raw: 0.994 },
                cashPosition: { raw: 0.006 },
                stockPosition: { raw: 0 },
              },
              summaryDetail: { yield: { raw: 0.0314 } },
            },
          ],
        },
      });

      const result = await service.fetchSecurityProfileDescription("AGGG.L");

      expect(result).toBe(
        "iShares Core Global Aggregate Bond UCITS ETF (BlackRock). ~99% bonds, ~1% cash. TER 0.10%, yield 3.14%.",
      );
    });

    it("returns null when neither prose nor structured data is available", async () => {
      mockFetchResponse({ quoteSummary: { result: [{}] } });

      const result = await service.fetchSecurityProfileDescription("XYZ");

      expect(result).toBeNull();
    });

    it("returns null on a non-200 response", async () => {
      mockFetchResponse({}, false, 500);

      const result = await service.fetchSecurityProfileDescription("AAPL");

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetchError(new Error("Network failure"));

      const result = await service.fetchSecurityProfileDescription("AAPL");

      expect(result).toBeNull();
    });
  });

  describe("fetchNews", () => {
    /** One item shaped the way the search endpoint's `news[]` carries them. */
    const newsItem = (overrides: any = {}) => ({
      uuid: "uuid-1",
      title: "Apple says UK App Store proposal amounts to price regulation",
      publisher: "Reuters",
      link: "https://finance.yahoo.com/news/apple-uk-app-store.html",
      providerPublishTime: 1785350000,
      type: "STORY",
      thumbnail: {
        resolutions: [
          { url: "https://s.yimg.com/big.jpg", width: 1200, height: 800 },
          { url: "https://s.yimg.com/small.jpg", width: 140, height: 140 },
        ],
      },
      relatedTickers: ["AAPL"],
      ...overrides,
    });

    it("asks the same search endpoint the symbol lookup uses, with news turned on", async () => {
      mockFetchResponse({ news: [] });
      await service.fetchNews("AAPL", 15);

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain("/v1/finance/search");
      expect(url).toContain("q=AAPL");
      // Quotes off, news on: the opposite of what lookupSecurityMany asks for.
      expect(url).toContain("quotesCount=0");
      expect(url).toContain("newsCount=15");
    });

    it("narrows an item to what the page renders", async () => {
      mockFetchResponse({ news: [newsItem()] });
      const [item] = await service.fetchNews("AAPL");

      expect(item).toEqual({
        id: "uuid-1",
        title: "Apple says UK App Store proposal amounts to price regulation",
        publisher: "Reuters",
        link: "https://finance.yahoo.com/news/apple-uk-app-store.html",
        publishedAt: new Date(1785350000 * 1000).toISOString(),
        type: "STORY",
        thumbnailUrl: "https://s.yimg.com/small.jpg",
        relatedTickers: ["AAPL"],
      });
    });

    it("reads the timestamp as seconds, not milliseconds", async () => {
      // Upstream sends Unix seconds; a millisecond reading dates every story
      // to 1970 and the list sorts and reads as nonsense.
      mockFetchResponse({
        news: [newsItem({ providerPublishTime: 1785350000 })],
      });
      const [item] = await service.fetchNews("AAPL");
      expect(item.publishedAt!.startsWith("2026-")).toBe(true);
    });

    it("keeps the smallest thumbnail that still covers the list's size", async () => {
      // The list draws these tiny; a 1200px hero is wasted bytes.
      mockFetchResponse({ news: [newsItem()] });
      const [item] = await service.fetchNews("AAPL");
      expect(item.thumbnailUrl).toBe("https://s.yimg.com/small.jpg");
    });

    it("has no thumbnail when none is offered over https", async () => {
      mockFetchResponse({
        news: [
          newsItem({
            thumbnail: {
              resolutions: [{ url: "http://s.yimg.com/x.jpg", width: 140 }],
            },
          }),
        ],
      });
      const [item] = await service.fetchNews("AAPL");
      expect(item.thumbnailUrl).toBeNull();
    });

    describe("items it refuses to return", () => {
      // The link becomes an anchor, so its scheme is a security control -- the
      // value comes from a third party and is no more trusted than a typed one.
      it.each([
        ["a javascript link", { link: "javascript:alert(1)" }],
        ["a data link", { link: "data:text/html,<script>alert(1)</script>" }],
        ["no link at all", { link: undefined }],
        ["no title", { title: "   " }],
      ])("drops %s", async (_name, overrides) => {
        mockFetchResponse({ news: [newsItem(overrides)] });
        expect(await service.fetchNews("AAPL")).toEqual([]);
      });
    });

    it("carries every ticker the item was filed under", async () => {
      // Filed by mention, not by subject: a Berkshire story listing AAPL fifth
      // comes back for AAPL, and the UI has to be able to say so.
      mockFetchResponse({
        news: [
          newsItem({
            title: "Berkshire slips despite UBS raising target",
            relatedTickers: ["BRK-B", "AAPL", "^GSPC", "UBS", "KO"],
          }),
        ],
      });
      const [item] = await service.fetchNews("AAPL");
      expect(item.relatedTickers).toEqual([
        "BRK-B",
        "AAPL",
        "^GSPC",
        "UBS",
        "KO",
      ]);
    });

    it("returns nothing rather than failing the page when upstream errors", async () => {
      // News is decoration on a page that works without it.
      mockFetchResponse({}, false, 503);
      expect(await service.fetchNews("AAPL")).toEqual([]);
    });

    it("returns nothing when the request throws", async () => {
      mockFetchError(new Error("network down"));
      expect(await service.fetchNews("AAPL")).toEqual([]);
    });

    it("tolerates a response with no news key", async () => {
      mockFetchResponse({ quotes: [] });
      expect(await service.fetchNews("AAPL")).toEqual([]);
    });
  });
  describe("provider availability (issue #1265)", () => {
    /**
     * Rejects with a *fresh* error each call, as undici does.
     *
     * One throw is one piece of evidence -- the health service counts an error
     * object once however many layers hand it on -- so a mock that rejects with
     * the same instance every time reports five failures as one and the breaker
     * never opens. `A mock must return what the real collaborator returns`
     * (docs/backend/testing.md).
     */
    const rejectEveryFetch = (make: () => Error) => {
      global.fetch = jest.fn(() => Promise.reject(make()));
    };

    /** The error undici raises when the container cannot resolve the host. */
    const dnsFailure = () => {
      const error = new TypeError("fetch failed");
      Object.assign(error, {
        cause: Object.assign(
          new Error("getaddrinfo EAI_AGAIN query1.finance.yahoo.com"),
          {
            code: "EAI_AGAIN",
            syscall: "getaddrinfo",
            hostname: "query1.finance.yahoo.com",
          },
        ),
      });
      return error;
    };

    it("stops calling an unreachable provider instead of retrying forever", async () => {
      // The bug: every chart render, every index chunk and every quote kept
      // calling out, so the log filled and the event loop carried hundreds of
      // doomed sockets. Five failures is enough evidence.
      rejectEveryFetch(dnsFailure);
      const fetchMock = global.fetch as jest.Mock;

      for (let i = 0; i < 5; i++) {
        expect(await service.fetchHistorical("^RUT", null, "1y")).toBeNull();
      }
      const callsWhenOpened = fetchMock.mock.calls.length;

      for (let i = 0; i < 50; i++) {
        expect(await service.fetchHistorical("^RUT", null, "1y")).toBeNull();
      }
      expect(fetchMock.mock.calls.length).toBe(callsWhenOpened);
    });

    it("refuses quotes, lookups and intraday from the same breaker", async () => {
      rejectEveryFetch(dnsFailure);
      const fetchMock = global.fetch as jest.Mock;
      for (let i = 0; i < 5; i++) {
        await service.fetchQuote("AAPL");
      }
      const callsWhenOpened = fetchMock.mock.calls.length;

      expect(await service.fetchQuote("MSFT")).toBeNull();
      expect(await service.lookupSecurityMany("micro")).toEqual([]);
      expect(await service.searchQuotes("ringgit", 20)).toBeNull();
      expect(
        await service.fetchIntradaySeries("MSFT", null, {
          interval: "5m",
          range: "1d",
        }),
      ).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(callsWhenOpened);
    });

    it("opens on a provider that answers headers and then stalls the body", async () => {
      // `recordSuccess` fires when the response headers arrive, and the body is
      // read by the caller -- so a provider that accepts the connection and then
      // stalls used to reset the failure run on every request, and the breaker
      // never opened. Counting happens at the log door as well for exactly this.
      const bodyStall = () =>
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("body timeout"), {
            code: "UND_ERR_BODY_TIMEOUT",
          }),
        });
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(bodyStall()),
          text: () => Promise.reject(bodyStall()),
        } as never),
      );
      const fetchMock = global.fetch as jest.Mock;

      for (let i = 0; i < 5; i++) {
        expect(await service.fetchHistorical("^RUT", null, "1y")).toBeNull();
      }
      const callsWhenOpened = fetchMock.mock.calls.length;

      for (let i = 0; i < 20; i++) {
        expect(await service.fetchHistorical("^RUT", null, "1y")).toBeNull();
      }
      expect(fetchMock.mock.calls.length).toBe(callsWhenOpened);
    });

    it("does not treat a stalled body as a recovered probe", async () => {
      // The flap this prevents: the probe got headers, the breaker called that a
      // recovery, the body then stalled, and four more requests went out before
      // it opened again -- once a window, forever. Each fresh episode also reset
      // the alert's fifteen-minute clock, so no alert was ever sent.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);
      const bodyStall = () =>
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("body timeout"), {
            code: "UND_ERR_BODY_TIMEOUT",
          }),
        });
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(bodyStall()),
          text: () => Promise.reject(bodyStall()),
        } as never),
      );

      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("open");
      const startedAt = timedHealth.snapshot("yahoo_finance").failingSince;

      // The window elapses, the probe goes out, and its body stalls too.
      clock += OPEN_WINDOW_MS + 1;
      await timedService.fetchHistorical("^RUT", null, "1y");

      const after = timedHealth.snapshot("yahoo_finance");
      expect(after.state).toBe("open");
      // Same episode, and the next window is longer rather than reset.
      expect(after.failingSince).toBe(startedAt);
      expect(timedHealth.wouldRefuse("yahoo_finance")).toBe(true);
    });

    it("closes on a probe whose body actually arrives", async () => {
      // The other half: a completed request has to close it, or an outage never
      // ends.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);

      global.fetch = jest.fn(() => Promise.reject(dnsFailure()));
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("open");

      clock += OPEN_WINDOW_MS + 1;
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              chart: {
                result: [
                  {
                    meta: { currency: "USD" },
                    timestamp: [1700000000],
                    indicators: { quote: [{ close: [10] }] },
                  },
                ],
              },
            }),
        } as never),
      );

      expect(
        await timedService.fetchHistorical("^RUT", null, "1y"),
      ).not.toBeNull();
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("closed");
    });

    it("frees the probe on a routine 404, on every path that can get one", async () => {
      // Nine branches used to record this for themselves and two forgot, each
      // leaving the exclusive probe slot held for two minutes against a
      // provider that had just answered. The rule now lives in one place, so
      // this walks the paths rather than the branches.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);
      // The crumb cache is checked against the real clock, not the breaker's.
      const seeded = timedService as unknown as {
        crumb: string;
        cookie: string;
        crumbExpiresAt: number;
      };
      seeded.crumb = "test-crumb";
      seeded.cookie = "test-cookie";
      seeded.crumbExpiresAt = Date.now() + 3_600_000;

      global.fetch = jest.fn(() => Promise.reject(dnsFailure()));
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("open");

      clock += OPEN_WINDOW_MS + 1;
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
        } as never),
      );

      // The probe is spent on an ETF-breakdown call, one of the two paths that
      // used to forget.
      await timedService.fetchEtfBreakdowns("SPY");

      expect(timedHealth.snapshot("yahoo_finance").state).toBe("closed");
      expect(timedHealth.wouldRefuse("yahoo_finance")).toBe(false);
    });

    it("counts one throw once, however many layers report it", async () => {
      // The fetch helper counts what it catches and rethrows; the caller's catch
      // hands the same object to the log door. Counting it twice would open the
      // breaker on three failures while the constant says five.
      rejectEveryFetch(dnsFailure);

      await service.fetchHistorical("SYM", null, "1y");

      // One count per request that failed, not one per layer that reported it.
      const fetchMock = global.fetch as jest.Mock;
      expect(health.snapshot("yahoo_finance").recentFailures).toBe(
        fetchMock.mock.calls.length,
      );
    });

    it("logs what actually failed, not `TypeError: fetch failed`", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      try {
        rejectEveryFetch(dnsFailure);
        await service.fetchHistorical("^RUT", null, "1y");

        const lines = warn.mock.calls.map((call) => String(call[0]));
        const line = lines.find((text) => text.includes("^RUT"));
        expect(line).toBeDefined();
        expect(line).toContain("EAI_AGAIN");
        expect(line).toContain("hostname=query1.finance.yahoo.com");
      } finally {
        warn.mockRestore();
      }
    });

    it("logs one line for a flood of identical failures", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      try {
        rejectEveryFetch(dnsFailure);
        for (let i = 0; i < 40; i++) {
          await service.fetchHistorical(`SYM${i}`, null, "1y");
        }
        const symbolLines = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((text) => text.includes("historical prices for"));
        expect(symbolLines).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("does not leave the probe slot held by a successful crumb handshake", async () => {
      // The crumb handshake takes the exclusive half-open probe slot. Reporting
      // no outcome on success held it for two minutes, during which every
      // Yahoo call in the process was refused -- with the provider healthy.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);

      rejectEveryFetch(dnsFailure);
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("open");

      clock += OPEN_WINDOW_MS + 1;
      // The handshake is the probe: cookies from https.get, crumb over fetch.
      (
        timedService as unknown as { fetchYahooCookie: () => Promise<string> }
      ).fetchYahooCookie = jest.fn().mockResolvedValue("A1=cookie");
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("abc123"),
      });

      const gotCrumb = await (
        timedService as unknown as { fetchCrumb: () => Promise<boolean> }
      ).fetchCrumb();

      expect(gotCrumb).toBe(true);
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("closed");
      // And the next ordinary request is allowed, rather than refused for the
      // probe timeout.
      expect(() => timedHealth.assertAvailable("yahoo_finance")).not.toThrow();
    });

    it("frees the probe slot even when the handshake is refused a crumb", async () => {
      // A 401 or a cookie-less response still proves the host answered.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);

      rejectEveryFetch(dnsFailure);
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      clock += OPEN_WINDOW_MS + 1;
      (
        timedService as unknown as { fetchYahooCookie: () => Promise<string> }
      ).fetchYahooCookie = jest.fn().mockResolvedValue("A1=cookie");
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve(""),
      });

      expect(
        await (
          timedService as unknown as { fetchCrumb: () => Promise<boolean> }
        ).fetchCrumb(),
      ).toBe(false);
      expect(timedHealth.snapshot("yahoo_finance").state).toBe("closed");
    });

    it("does not let a cookie host's answer stand in for the API host", async () => {
      // The cookie sources are fc.yahoo.com and finance.yahoo.com; everything
      // else talks to query1.finance.yahoo.com. Counting a cookie response as
      // "the provider answered" kept the failure run oscillating between 0 and
      // 1 while the API host was down, so the breaker never opened.
      const clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);
      (
        timedService as unknown as { fetchYahooCookie: () => Promise<string> }
      ).fetchYahooCookie = jest.fn().mockResolvedValue("A1=cookie");

      // The API host refuses every connection; the cookie host is fine.
      rejectEveryFetch(dnsFailure);
      for (let i = 0; i < 5; i++) {
        await (
          timedService as unknown as { fetchCrumb: () => Promise<boolean> }
        ).fetchCrumb();
      }

      expect(timedHealth.snapshot("yahoo_finance").state).toBe("open");
    });

    it("gives the probe back when the API host was never reached", async () => {
      // Every cookie source answers, none with a cookie: the handshake gives up
      // before calling the API host, so there is nothing to record -- but the
      // slot still has to go back, or two minutes of Yahoo calls are refused
      // for a provider nothing has shown to be down.
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);

      rejectEveryFetch(dnsFailure);
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      clock += OPEN_WINDOW_MS + 1;
      (
        timedService as unknown as { fetchYahooCookie: () => Promise<string> }
      ).fetchYahooCookie = jest.fn().mockResolvedValue("");

      expect(
        await (
          timedService as unknown as { fetchCrumb: () => Promise<boolean> }
        ).fetchCrumb(),
      ).toBe(false);

      // Nothing was learned, so the failure run stands -- but the next caller
      // may probe rather than waiting out the probe timeout.
      expect(timedHealth.snapshot("yahoo_finance").recentFailures).toBe(5);
      expect(timedHealth.wouldRefuse("yahoo_finance")).toBe(false);
      expect(timedHealth.tryRequest("yahoo_finance")).toBe("probe");
    });

    it("resumes once the provider answers again", async () => {
      let clock = 1_700_000_000_000;
      const timedHealth = createTestProviderHealth(() => clock);
      const timedService = new YahooFinanceService(timedHealth);

      rejectEveryFetch(dnsFailure);
      for (let i = 0; i < 5; i++) {
        await timedService.fetchHistorical("^RUT", null, "1y");
      }
      const fetchMock = global.fetch as jest.Mock;
      const callsWhenOpened = fetchMock.mock.calls.length;

      // Inside the window: nothing leaves the process.
      await timedService.fetchHistorical("^RUT", null, "1y");
      expect(fetchMock.mock.calls.length).toBe(callsWhenOpened);

      // Window elapsed: one probe, and a good answer re-opens the gates.
      clock += OPEN_WINDOW_MS + 1;
      mockFetchResponse({
        chart: {
          result: [
            {
              meta: {
                currency: "USD",
                exchangeTimezoneName: "America/New_York",
              },
              timestamp: [1700000000],
              indicators: {
                quote: [
                  { close: [10], open: [9], high: [11], low: [8], volume: [1] },
                ],
              },
            },
          ],
        },
      });
      const recovered = await timedService.fetchHistorical("^RUT", null, "1y");
      expect(recovered).not.toBeNull();
      expect(await timedService.fetchQuote("AAPL")).not.toBeNull();
    });
  });
});
