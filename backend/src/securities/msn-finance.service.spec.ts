import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { MsnFinanceService, msnInternals } from "./msn-finance.service";

describe("MsnFinanceService", () => {
  let service: MsnFinanceService;
  let originalFetch: typeof global.fetch;

  const createResponse = (body: unknown, ok = true, status = 200) =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : ""),
    } as Response);

  beforeEach(async () => {
    originalFetch = global.fetch;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MsnFinanceService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "MSN_API_KEY" ? "test-msn-api-key" : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(MsnFinanceService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── pure helpers ──────────────────────────────────────────────────────

  describe("mapRangeToMsn", () => {
    it("maps common range strings", () => {
      expect(msnInternals.mapRangeToMsn("1y")).toBe("1Y");
      expect(msnInternals.mapRangeToMsn("max")).toBe("MAX");
      expect(msnInternals.mapRangeToMsn("5y")).toBe("5Y");
      expect(msnInternals.mapRangeToMsn("1d")).toBe("1D");
      expect(msnInternals.mapRangeToMsn("ytd")).toBe("YTD");
    });
    it("defaults unknown ranges to 1Y", () => {
      expect(msnInternals.mapRangeToMsn("weird")).toBe("1Y");
    });
  });

  describe("parseMsnDate", () => {
    it("parses seconds-since-epoch", () => {
      const d = msnInternals.parseMsnDate(1700000000);
      expect(d).toBeInstanceOf(Date);
      expect(d!.getUTCFullYear()).toBe(2023);
    });
    it("parses ms-since-epoch", () => {
      const d = msnInternals.parseMsnDate(1700000000000);
      expect(d!.getUTCFullYear()).toBe(2023);
    });
    it("parses ISO strings", () => {
      const d = msnInternals.parseMsnDate("2024-06-15");
      expect(d!.getUTCFullYear()).toBe(2024);
    });
    it("returns null for invalid input", () => {
      expect(msnInternals.parseMsnDate(null)).toBeNull();
      expect(msnInternals.parseMsnDate("not-a-date")).toBeNull();
    });
  });

  describe("extractQuoteFields", () => {
    it("reads PascalCase and camelCase fields", () => {
      const q = msnInternals.extractQuoteFields({
        Symbol: "MSFT",
        LastPrice: 420,
        Open: 419,
        DayHigh: 425,
        DayLow: 418,
        Volume: 1000,
        Currency: "USD",
        LastTradeTime: "2024-06-15T20:00:00Z",
      });
      expect(q).toMatchObject({
        symbol: "MSFT",
        price: 420,
        open: 419,
        high: 425,
        low: 418,
        volume: 1000,
        currency: "USD",
      });
      expect(q.time).toBeGreaterThan(1700000000);
    });
  });

  // ─── resolveInstrumentId ───────────────────────────────────────────────

  describe("resolveInstrumentId", () => {
    it("returns SecId for matching ticker and caches the result", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [{ Symbol: "AAPL", SecId: "a1u3p2", Exchange: "XNAS" }],
          },
        }),
      );

      const first = await service.resolveInstrumentId("AAPL", "NASDAQ");
      expect(first).toBe("a1u3p2");

      // Second call must hit the cache (no additional fetch).
      const second = await service.resolveInstrumentId("AAPL", "NASDAQ");
      expect(second).toBe("a1u3p2");
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });

    it("prefers the exchange match when multiple candidates are returned", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              { Symbol: "SHOP", SecId: "us-shop", Exchange: "XNYS" },
              { Symbol: "SHOP", SecId: "ca-shop", Exchange: "XTSE" },
            ],
          },
        }),
      );

      const id = await service.resolveInstrumentId("SHOP", "TSX");
      expect(id).toBe("ca-shop");
    });

    it("prioritizes the user's preferred exchanges when security has no exchange", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              { Symbol: "RY", SecId: "us-ry", Exchange: "XNYS" },
              { Symbol: "RY", SecId: "ca-ry", Exchange: "XTSE" },
            ],
          },
        }),
      );

      const id = await service.resolveInstrumentId("RY", null, ["TSX", "NYSE"]);
      expect(id).toBe("ca-ry");
    });

    it("retries against en-us when the en-ca market returns nothing", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [] } }))
        .mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [{ Symbol: "AAPL", SecId: "a1u3p2", Exchange: "XNAS" }],
            },
          }),
        );

      const id = await service.resolveInstrumentId("AAPL", "TSX");
      expect(id).toBe("a1u3p2");
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
    });

    it("caches negative lookups so repeated failures don't re-query", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ data: { stocks: [] } }));

      await service.resolveInstrumentId("BOGUS", "NASDAQ");
      await service.resolveInstrumentId("BOGUS", "NASDAQ");

      // Two markets tried on the first call; cache hit on the second.
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
    });
  });

  // ─── fetchQuote ────────────────────────────────────────────────────────

  describe("fetchQuote", () => {
    it("uses the pre-supplied instrumentId and maps Market/Get fields to QuoteResult", async () => {
      // Market/Get response: bare-array shape with the documented field names.
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse([
          {
            SecId: "a1u3p2",
            FriendlyName: "Apple Inc",
            price: 180.5,
            priceDayOpen: 179,
            priceDayHigh: 181,
            priceDayLow: 178.5,
            accumulatedVolume: 55000000,
            currency: "USD",
            timeLastTraded: "2024-06-15T20:00:00Z",
          },
        ]),
      );

      const quote = await service.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });

      expect(quote).not.toBeNull();
      expect(quote!.regularMarketPrice).toBe(180.5);
      expect(quote!.regularMarketOpen).toBe(179);
      expect(quote!.regularMarketDayHigh).toBe(181);
      expect(quote!.regularMarketDayLow).toBe(178.5);
      expect(quote!.provider).toBe("msn");
      // Should NOT have called autosuggest since instrumentId was provided.
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });

    it("accepts the { stocks: [...] } response envelope", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          stocks: [
            {
              SecId: "a1u3p2",
              price: 175.25,
              currency: "USD",
            },
          ],
        }),
      );
      const quote = await service.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });
      expect(quote!.regularMarketPrice).toBe(175.25);
    });

    it("converts GBX pence to GBP when MSN reports pence", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse([
          {
            SecId: "voduk1",
            price: 12050, // pence
            priceDayOpen: 12000,
            currency: "GBX",
          },
        ]),
      );

      // SecId-shaped instrumentId so the proactive re-resolve doesn't fire.
      const quote = await service.fetchQuote("VOD", "LSE", {
        instrumentId: "voduk1",
      });

      // 12050 pence → 120.50 GBP
      expect(quote!.regularMarketPrice).toBeCloseTo(120.5, 2);
      expect(quote!.regularMarketOpen).toBeCloseTo(120, 2);
    });

    it("re-resolves to SecId via autosuggest when stored ID is the FullInstrument form", async () => {
      // Existing user data may carry FullInstrument-style IDs (e.g.
      // "F0CAN05MQP") because earlier versions extracted that field. The
      // Quotes endpoint 404s on those — so we PROACTIVELY re-resolve via
      // autosuggest before the first Quotes call.
      global.fetch = jest
        .fn()
        // 1. Autosuggest returns the short SecId.
        .mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [{ Symbol: "ATL8021", SecId: "abc12y" }],
            },
          }),
        )
        // 2. Quotes call with the SecId returns price.
        .mockReturnValueOnce(
          createResponse([{ SecId: "abc12y", price: 12.34, currency: "CAD" }]),
        );

      const quote = await service.fetchQuote("ATL8021", null, {
        instrumentId: "F0CAN05MQP",
      });
      expect(quote).not.toBeNull();
      expect(quote!.regularMarketPrice).toBe(12.34);
      expect(quote!.provider).toBe("msn");
      // The upgraded SecId is exposed so the caller can persist it.
      expect(quote!.msnResolvedInstrumentId).toBe("abc12y");
    });

    it("returns null when MSN returns HTTP error", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({}, false, 503));

      const quote = await service.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });
      expect(quote).toBeNull();
    });

    it("falls back to chart-timeseries when the direct quote endpoint has no price", async () => {
      global.fetch = jest
        .fn()
        // direct quote endpoint: no usable price
        .mockReturnValueOnce(createResponse({ value: [{ Symbol: "AAPL" }] }))
        // chart-timeseries endpoint: returns a recent OHLCV point
        .mockReturnValueOnce(
          createResponse({
            series: [
              {
                Time: "2024-06-15",
                Close: 178,
                Open: 176,
                High: 179,
                Low: 175.5,
              },
              {
                Time: "2024-06-17",
                Close: 181,
                Open: 180,
                High: 182,
                Low: 179.5,
              },
            ],
            Currency: "USD",
          }),
        );

      const quote = await service.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });
      expect(quote).not.toBeNull();
      // Latest point wins.
      expect(quote!.regularMarketPrice).toBe(181);
      expect(quote!.regularMarketOpen).toBe(180);
      expect(quote!.regularMarketDayHigh).toBe(182);
      expect(quote!.regularMarketDayLow).toBe(179.5);
      expect(quote!.provider).toBe("msn");
    });

    it("returns null when the price field is missing", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ value: [{ Symbol: "AAPL" }] }));

      const quote = await service.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });
      expect(quote).toBeNull();
    });

    it("resolves instrumentId automatically when not supplied", async () => {
      global.fetch = jest
        .fn()
        // autosuggest
        .mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [{ Symbol: "AAPL", SecId: "a1u3p2", Exchange: "XNAS" }],
            },
          }),
        )
        // Market/Get quote
        .mockReturnValueOnce(
          createResponse([{ SecId: "a1u3p2", price: 180, currency: "USD" }]),
        );

      const quote = await service.fetchQuote("AAPL", "NASDAQ");
      expect(quote).not.toBeNull();
      expect(quote!.regularMarketPrice).toBe(180);
    });
  });

  // ─── fetchHistorical ───────────────────────────────────────────────────

  describe("fetchHistorical", () => {
    it("maps the chart series to HistoricalPrice[] sorted ascending", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          series: [
            {
              Time: "2024-06-17",
              Open: 181,
              High: 183,
              Low: 180,
              Close: 182,
              Volume: 1000,
            },
            {
              Time: "2024-06-15",
              Open: 178,
              High: 181,
              Low: 177.5,
              Close: 180,
              Volume: 2000,
            },
          ],
          Currency: "USD",
        }),
      );

      const prices = await service.fetchHistorical("AAPL", "NASDAQ", "1y", {
        instrumentId: "a1u3p2",
      });

      expect(prices).not.toBeNull();
      expect(prices!.length).toBe(2);
      expect(prices![0].date < prices![1].date).toBe(true);
      expect(prices![0].close).toBe(180);
      expect(prices![1].close).toBe(182);
    });

    it("applies GBX→GBP conversion to every row", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          series: [{ Time: "2024-06-15", Close: 10000, High: 10100 }],
          Currency: "GBX",
        }),
      );

      const prices = await service.fetchHistorical("VOD", "LSE", "1y", {
        instrumentId: "vod-lse",
      });
      expect(prices![0].close).toBeCloseTo(100, 2);
      expect(prices![0].high).toBeCloseTo(101, 2);
    });

    it("returns null when MSN has no series", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ series: [] }));
      const prices = await service.fetchHistorical("AAPL", "NASDAQ", "1y", {
        instrumentId: "a1u3p2",
      });
      expect(prices).toBeNull();
    });
  });

  // ─── lookupSecurity ────────────────────────────────────────────────────

  describe("lookupSecurity", () => {
    it("prefers results on the user's preferred exchange", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "SHOP",
                SecId: "us-shop",
                Exchange: "XNYS",
                Name: "Shopify Inc",
                Currency: "USD",
              },
              {
                Symbol: "SHOP",
                SecId: "ca-shop",
                Exchange: "XTSE",
                Name: "Shopify Inc",
                Currency: "CAD",
              },
            ],
          },
        }),
      );

      const result = await service.lookupSecurity("SHOP", ["TSX"]);
      expect(result).not.toBeNull();
      expect(result!.exchange).toBe("TSX");
      expect(result!.currencyCode).toBe("CAD");
    });

    it("returns null when MSN has no results", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ data: { stocks: [] } }));

      const result = await service.lookupSecurity("BOGUS");
      expect(result).toBeNull();
    });

    it("parses MSN's stringified-JSON stock entries with OS001/OS01W/FullInstrument fields", async () => {
      // Each stocks[] element is a stringified JSON blob with cryptic field
      // codes — matches what Bing actually returns for mutual fund queries.
      const stockBlob = JSON.stringify({
        OS001: "BMO692",
        OS01W: "BMO Global Dividend Opportunities Fund Series A",
        OS0LN: "BMO Global Dividend Opportunities Fund Series A",
        RT0SN: "BMO Global Dividend Opportunities Fund Series A",
        FullInstrument: "F18068765888",
        Currency: "CAD",
      });
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [stockBlob] } }));

      const result = await service.lookupSecurity("BMO Dividend Fund");
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("BMO692");
      expect(result!.name).toBe(
        "BMO Global Dividend Opportunities Fund Series A",
      );
      expect(result!.msnInstrumentId).toBe("F18068765888");
      expect(result!.currencyCode).toBe("CAD");
    });

    it("uses OS01W/OS0LN for Name when DisplayName is the ticker (mutual fund case)", async () => {
      // Real payload from Bing for a TD mutual fund: DisplayName is "TDB164"
      // (the ticker), but OS01W / OS0LN / RT0SN hold the actual fund name.
      // OS010="FO" → MUTUAL_FUND, RT0EC/LS01Z="CA" → CAD currency.
      const stockBlob = JSON.stringify({
        OS001: "TDB164",
        OS001Index: "tdb164",
        OS01W: "TD Canadian Money Market Investor Series",
        RT0SN: "TD Canadian Money Market Investor Series",
        OS0LN: "TD Canadian Money Market Investor Series",
        OS010: "FO",
        RT0EC: "CA",
        ExMicCode: "CA",
        LS01Z: "CA",
        FriendlyName: "TD Canadian MMkt Inv Srs",
        DisplayName: "TDB164", // <-- the trap
        FullInstrument: "F18068004373",
        SecId: "bb36yc",
      });
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [stockBlob] } }));

      const result = await service.lookupSecurity("TD Canadian Money Market");
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("TDB164");
      expect(result!.name).toBe("TD Canadian Money Market Investor Series");
      expect(result!.securityType).toBe("MUTUAL_FUND");
      expect(result!.currencyCode).toBe("CAD");
      // SecId (short form) is what MSN's Quotes endpoint accepts; we prefer
      // it over FullInstrument (which the endpoint 404s on).
      expect(result!.msnInstrumentId).toBe("bb36yc");
    });

    it("returns null when the match has no Symbol/OS001 and no FullInstrument/SecId", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              JSON.stringify({
                RT00S: "",
                OS01WIndex: "some index",
                Currency: "CAD",
              }),
            ],
          },
        }),
      );

      const result = await service.lookupSecurity("Bogus Name");
      expect(result).toBeNull();
    });

    it("returns provider + msnInstrumentId and reads alternate field names", async () => {
      // Bing sometimes returns camelCase fields, a DisplayName instead of Name,
      // and a Mic instead of Exchange. Make sure we still extract everything.
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                symbol: "XEQT",
                secId: "xeqt-mic",
                displayName: "iShares Core Equity ETF",
                mic: "XTSE",
                instrumentType: "ETF",
                currencyCode: "CAD",
              },
            ],
          },
        }),
      );

      const result = await service.lookupSecurity("XEQT", ["TSX"]);
      expect(result).toEqual({
        symbol: "XEQT",
        name: "iShares Core Equity ETF",
        exchange: "TSX",
        securityType: "ETF",
        currencyCode: "CAD",
        provider: "msn",
        msnInstrumentId: "xeqt-mic",
      });
    });
  });

  describe("fetchEtfSectorWeightings", () => {
    it("returns null (v1 does not support MSN ETF weightings)", async () => {
      const result = await service.fetchEtfSectorWeightings();
      expect(result).toBeNull();
    });
  });

  // ─── branch coverage: helper-driven branches via lookupSecurity ────────

  describe("branch coverage extras", () => {
    it("mapMsnSecurityType: returns null for IX (index)", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "SPX",
                SecId: "spx1",
                Name: "S&P 500",
                Exchange: "XNAS",
                SecurityType: "IX",
              },
            ],
          },
        }),
      );
      const r = await service.lookupSecurity("SPX");
      expect(r!.securityType).toBeNull();
    });

    it("mapMsnSecurityType: returns ETF for ETP/exchange-traded fund text", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "VOO",
                SecId: "voo1",
                Name: "Vanguard ETP",
                Exchange: "XNYS",
                SecurityType: "EXCHANGE TRADED FUND",
              },
            ],
          },
        }),
      );
      const r = await service.lookupSecurity("VOO");
      expect(r!.securityType).toBe("ETF");
    });

    it("mapMsnSecurityType: maps BOND/OPTION/CRYPTO/STOCK variants", async () => {
      const cases: Array<[string, string]> = [
        ["BOND", "BOND"],
        ["FIXED INCOME", "BOND"],
        ["OPT", "OPTION"],
        ["DIGITAL CURRENCY", "CRYPTO"],
        ["CRYPTOCURRENCY", "CRYPTO"],
        ["CS", "STOCK"],
        ["PS", "STOCK"],
        ["ADR", "STOCK"],
        ["EQUITY", "STOCK"],
        ["UNKNOWN_TYPE_XYZ", null as unknown as string],
        ["MUTUAL FUND", "MUTUAL_FUND"],
        ["MF", "MUTUAL_FUND"],
        ["OEF", "MUTUAL_FUND"],
        ["FUND", "MUTUAL_FUND"],
      ];
      for (const [secType, expected] of cases) {
        global.fetch = jest.fn().mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [
                {
                  Symbol: "X",
                  SecId: "x1",
                  Name: "Some Inc",
                  Exchange: "XNYS",
                  SecurityType: secType,
                },
              ],
            },
          }),
        );
        const r = await service.lookupSecurity("X");
        expect(r!.securityType).toBe(expected);
      }
    });

    it("currencyFromExchange: maps various non-USD exchanges", async () => {
      const cases: Array<[string, string]> = [
        ["LSE", "GBP"],
        ["LONDON", "GBP"],
        ["ASX", "AUD"],
        ["FRANKFURT", "EUR"],
        ["XETRA", "EUR"],
        ["PARIS", "EUR"],
        ["TOKYO", "JPY"],
        ["HKEX", "HKD"],
        ["HONG KONG", "HKD"],
        ["TSX-V", "CAD"],
        ["TSXV", "CAD"],
        ["CSE", "CAD"],
        ["NEO", "CAD"],
      ];
      for (const [exch, ccy] of cases) {
        const mic = msnInternals.EXCHANGE_TO_MSN[exch];
        global.fetch = jest.fn().mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [
                {
                  Symbol: "X",
                  SecId: "x1",
                  Name: "X",
                  Exchange: mic,
                },
              ],
            },
          }),
        );
        const r = await service.lookupSecurity("X", [exch]);
        expect(r!.currencyCode).toBe(ccy);
      }
    });

    it("currencyFromExchange: defaults to USD for unknown", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "X",
                SecId: "x1",
                Name: "X Inc",
                Exchange: "XNAS",
              },
            ],
          },
        }),
      );
      const r = await service.lookupSecurity("X");
      expect(r!.currencyCode).toBe("USD");
    });

    it("currencyFromCountryCode: infers via locale fallback", async () => {
      const stockBlob = JSON.stringify({
        OS001: "FOO",
        OS01W: "Foo Fund Series",
        FullInstrument: "F999",
        locale: "en-au",
      });
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [stockBlob] } }));
      const r = await service.lookupSecurity("FOO");
      expect(r!.currencyCode).toBe("AUD");
    });

    it("currencyFromCountryCode: returns null when neither code nor locale", async () => {
      const stockBlob = JSON.stringify({
        OS001: "FOO",
        OS01W: "Foo Fund Series Name",
        FullInstrument: "F999",
      });
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [stockBlob] } }));
      const r = await service.lookupSecurity("FOO");
      // No exchange (no Exchange field), no currency, no locale → null
      expect(r!.currencyCode).toBeNull();
    });

    it("countryToCurrency: handles US/GB/UK/JP/HK/CH/SE/NO/DK/IT/ES/NL/FR/DE", async () => {
      const codes = [
        ["US", "USD"],
        ["GB", "GBP"],
        ["UK", "GBP"],
        ["JP", "JPY"],
        ["HK", "HKD"],
        ["CH", "CHF"],
        ["SE", "SEK"],
        ["NO", "NOK"],
        ["DK", "DKK"],
        ["IT", "EUR"],
        ["ES", "EUR"],
        ["NL", "EUR"],
        ["FR", "EUR"],
        ["DE", "EUR"],
        ["XX", null],
      ];
      for (const [country, expected] of codes) {
        const stockBlob = JSON.stringify({
          OS001: "X",
          OS01W: "X Fund",
          FullInstrument: "F1",
          RT0EC: country,
        });
        global.fetch = jest.fn().mockReturnValueOnce(
          createResponse({ data: { stocks: [stockBlob] } }),
        );
        const r = await service.lookupSecurity("X");
        expect(r!.currencyCode).toBe(expected);
      }
    });

    it("scanExchangeCode: picks up unmapped exchange-shaped string field", async () => {
      // No mapped exchange field, but a free-form key contains a MIC.
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "X",
                SecId: "x1",
                Name: "X Inc",
                Misc: "XNAS",
              },
            ],
          },
        }),
      );
      const r = await service.lookupSecurity("X");
      expect(r!.exchange).toBe("NASDAQ");
    });

    it("findLongestNameField: falls back to long string when no named candidate", async () => {
      const stockBlob = JSON.stringify({
        OS001: "ZZZ",
        FullInstrument: "F12345",
        SecId: "sec123",
        // No standard name fields. A "weird" field carrying a proper-ish name.
        WeirdKey: "Some Company Long Name LLC",
      });
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse({ data: { stocks: [stockBlob] } }));
      const r = await service.lookupSecurity("ZZZ");
      expect(r!.name).toBe("Some Company Long Name LLC");
    });

    it("preferredExchangePriority: unknown exchange gets last priority", async () => {
      // 2 candidates, first has unknown MIC, second matches preferred.
      // The preferred one (XNAS via NASDAQ) should sort first.
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          data: {
            stocks: [
              {
                Symbol: "X",
                SecId: "x-other",
                Name: "X Other",
                Exchange: "XUNKNOWN",
              },
              {
                Symbol: "X",
                SecId: "x-nas",
                Name: "X NAS",
                Exchange: "XNAS",
              },
            ],
          },
        }),
      );
      const all = await service.lookupSecurityMany("X", ["NASDAQ"]);
      expect(all[0].exchange).toBe("NASDAQ");
    });

    it("retries en-us when en-ca empty (lookupSecurityMany with prefs)", async () => {
      global.fetch = jest
        .fn()
        // first call (en-ca because pref is canadian) → empty
        .mockReturnValueOnce(createResponse({ data: { stocks: [] } }))
        // second call (en-us) → result
        .mockReturnValueOnce(
          createResponse({
            data: {
              stocks: [
                {
                  Symbol: "AAPL",
                  SecId: "a1",
                  Name: "Apple Inc",
                  Exchange: "XNAS",
                },
              ],
            },
          }),
        );
      const r = await service.lookupSecurityMany("AAPL", ["TSX"]);
      expect(r.length).toBe(1);
      expect(r[0].symbol).toBe("AAPL");
    });

    it("returns empty array when both markets empty in lookupSecurityMany", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ data: { stocks: [] } }));
      const r = await service.lookupSecurityMany("BOGUS");
      expect(r).toEqual([]);
    });
  });

  describe("isApiKeyConfigured", () => {
    it("returns true when MSN_API_KEY is set", () => {
      expect(service.isApiKeyConfigured()).toBe(true);
    });

    it("returns false when MSN_API_KEY is empty", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MsnFinanceService,
          {
            provide: ConfigService,
            useValue: { get: () => "   " },
          },
        ],
      }).compile();
      const svc = module.get(MsnFinanceService);
      expect(svc.isApiKeyConfigured()).toBe(false);
    });

    it("returns false when ConfigService not provided", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [MsnFinanceService],
      }).compile();
      const svc = module.get(MsnFinanceService);
      expect(svc.isApiKeyConfigured()).toBe(false);
    });
  });

  describe("fetchQuote: API key absence", () => {
    it("returns null from tryDirectQuote when no apiKey, then chart fallback also fails", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MsnFinanceService,
          {
            provide: ConfigService,
            useValue: { get: () => undefined },
          },
        ],
      }).compile();
      const svc = module.get(MsnFinanceService);
      // Chart endpoint also returns empty, so overall null.
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ series: [] }));
      const q = await svc.fetchQuote("AAPL", "NASDAQ", {
        instrumentId: "a1u3p2",
      });
      expect(q).toBeNull();
    });
  });

  describe("normalizeTimestamp branch", () => {
    it("handles invalid string timestamp", () => {
      const q = msnInternals.extractQuoteFields({
        Symbol: "X",
        Time: "not-a-date",
      });
      expect(q.time).toBeUndefined();
    });
    it("handles missing timestamp", () => {
      const q = msnInternals.extractQuoteFields({ Symbol: "X" });
      expect(q.time).toBeUndefined();
    });
    it("parses millisecond numeric timestamp", () => {
      const q = msnInternals.extractQuoteFields({
        Symbol: "X",
        Time: 1700000000000,
      });
      expect(q.time).toBe(1700000000);
    });
    it("parses second numeric timestamp", () => {
      const q = msnInternals.extractQuoteFields({
        Symbol: "X",
        Time: 1700000000,
      });
      expect(q.time).toBe(1700000000);
    });
  });

  describe("parseMsnDate branches", () => {
    it("returns null for non-finite seconds", () => {
      // very-large numbers still produce a date; test object branch
      expect(msnInternals.parseMsnDate({} as unknown)).toBeNull();
    });
  });

  describe("mapRangeToMsn extra ranges", () => {
    it("maps 1mo, 1m, 6mo, 6m, all variants", () => {
      expect(msnInternals.mapRangeToMsn("1mo")).toBe("1M");
      expect(msnInternals.mapRangeToMsn("1m")).toBe("1M");
      expect(msnInternals.mapRangeToMsn("6mo")).toBe("6M");
      expect(msnInternals.mapRangeToMsn("6m")).toBe("6M");
      expect(msnInternals.mapRangeToMsn("all")).toBe("MAX");
    });
  });

  describe("fetchHistorical default range", () => {
    it("uses default 'max' when no range supplied", async () => {
      global.fetch = jest.fn().mockReturnValueOnce(
        createResponse({
          series: [{ Time: "2024-06-15", Close: 100 }],
          Currency: "USD",
        }),
      );
      const prices = await service.fetchHistorical("X", null, undefined, {
        instrumentId: "x1",
      });
      expect(prices).not.toBeNull();
      expect(prices![0].close).toBe(100);
    });

    it("returns null when instrumentId cannot be resolved", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ data: { stocks: [] } }));
      const prices = await service.fetchHistorical("X", null);
      expect(prices).toBeNull();
    });
  });

  describe("fetchStockSectorInfo", () => {
    it("returns null when instrumentId cannot resolve", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValue(createResponse({ data: { stocks: [] } }));
      const r = await service.fetchStockSectorInfo("X", null);
      expect(r).toBeNull();
    });

    it("returns null on HTTP error", async () => {
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(createResponse("", false, 500));
      const r = await service.fetchStockSectorInfo("X", null, {
        instrumentId: "x1",
      });
      expect(r).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new Error("boom"));
      const r = await service.fetchStockSectorInfo("X", null, {
        instrumentId: "x1",
      });
      expect(r).toBeNull();
    });

    it("returns sector/industry when present in HTML", async () => {
      const html = `<html><script>{"sector":"Tech","industry":"Software"}</script></html>`;
      global.fetch = jest.fn().mockReturnValueOnce(createResponse(html));
      const r = await service.fetchStockSectorInfo("X", null, {
        instrumentId: "x1",
      });
      expect(r).toEqual({ sector: "Tech", industry: "Software" });
    });

    it("returns nulls inside object when neither match", async () => {
      const html = `<html>nothing</html>`;
      global.fetch = jest.fn().mockReturnValueOnce(createResponse(html));
      const r = await service.fetchStockSectorInfo("X", null, {
        instrumentId: "x1",
      });
      expect(r).toEqual({ sector: null, industry: null });
    });
  });

  describe("getTradingDate", () => {
    it("returns a Date from quote", () => {
      const d = service.getTradingDate({
        symbol: "X",
        regularMarketTime: 1700000000,
        provider: "msn",
      });
      expect(d).toBeInstanceOf(Date);
    });
  });

  describe("httpGetJson error path", () => {
    it("returns null when fetch throws (used by lookupSecurity)", async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("network failure"));
      const r = await service.lookupSecurity("X");
      expect(r).toBeNull();
    });

    it("returns null when fetch throws non-Error", async () => {
      global.fetch = jest.fn().mockRejectedValue("string error");
      const r = await service.lookupSecurity("X");
      expect(r).toBeNull();
    });
  });
});
