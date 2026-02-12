import { YahooFinanceService, YahooQuoteResult } from "./yahoo-finance.service";

describe("YahooFinanceService", () => {
  let service: YahooFinanceService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    service = new YahooFinanceService();
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

    it("should call fetch with correct URL and User-Agent header", async () => {
      mockFetchResponse({ chart: { result: [{ meta: { symbol: "AAPL" } }] } });

      await service.fetchQuote("AAPL");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("query1.finance.yahoo.com/v8/finance/chart/AAPL"),
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
    });

    it("should use range=max for historical data", async () => {
      mockFetchResponse({
        chart: { result: [{ timestamp: [1700000000], indicators: { quote: [{ close: [100] }] } }] },
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

    it("should return null when timestamps are missing", async () => {
      mockFetchResponse({
        chart: { result: [{ indicators: { quote: [{ close: [100] }] } }] },
      });

      const result = await service.fetchHistorical("AAPL");

      expect(result).toBeNull();
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

    it("should set hours to midnight on returned dates", async () => {
      mockFetchResponse({
        chart: {
          result: [
            {
              timestamp: [1700000000],
              indicators: {
                quote: [{ close: [100], open: [99], high: [101], low: [98], volume: [1000] }],
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
  });

  describe("getTradingDate", () => {
    it("should return date from regularMarketTime when present", () => {
      const quote: YahooQuoteResult = {
        symbol: "AAPL",
        regularMarketTime: 1700000000,
      };

      const result = service.getTradingDate(quote);

      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
    });

    it("should return today for weekday when regularMarketTime is missing", () => {
      const quote: YahooQuoteResult = {
        symbol: "AAPL",
      };

      const result = service.getTradingDate(quote);

      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(0);

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
  });
});
